package com.memorylane.glasses

import android.Manifest
import android.app.Application
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.removeCamera
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.selectors.DeviceSelector
import com.meta.wearable.dat.core.selectors.SpecificDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.Device
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.core.types.ThermalLevel
import com.meta.wearable.dat.display.Display
import com.meta.wearable.dat.display.addDisplay
import com.meta.wearable.dat.display.types.DisplayState
import com.meta.wearable.dat.display.types.VideoCodec
import com.meta.wearable.dat.display.types.VideoPlayerState
import com.meta.wearable.dat.display.types.VideoSource
import com.meta.wearable.dat.display.views.VideoPlayer
import com.meta.wearable.dat.inputs.addInputs
import com.meta.wearable.dat.inputs.removeInputs
import com.meta.wearable.dat.inputs.types.CapturePressType
import com.meta.wearable.dat.inputs.types.InputEvent
import com.meta.wearable.dat.inputs.types.InputSource
import com.meta.wearable.dat.inputs.types.InputsConfiguration
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockGlasses
import com.meta.wearable.dat.mockdevice.api.camera.CameraFacing
import com.meta.wearable.dat.mockdevice.api.display.MockDisplayKit
import com.meta.wearable.dat.mockdevice.api.speech.MockSpeechSource
import com.meta.wearable.dat.speech.Speech
import com.meta.wearable.dat.motion.addMotion
import com.meta.wearable.dat.motion.removeMotion
import com.meta.wearable.dat.motion.types.MotionConfiguration
import com.meta.wearable.dat.motion.types.MotionSamplingRate
import com.meta.wearable.dat.motion.types.MotionSource
import com.meta.wearable.dat.speech.addSpeech
import com.meta.wearable.dat.speech.removeSpeech
import com.meta.wearable.dat.speech.types.SpeechState
import com.meta.wearable.dat.speech.types.TranscriptionResult
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import kotlin.math.roundToInt
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

enum class Source { NONE, SIMULATED, REAL }

enum class Link { OFF, CONNECTING, READY, LOST }

enum class Phase { OFF, NEEDS_CONSENT, IDLE, LOOKING, OFFER, PERSON, MEMORY, ANSWERING, UNKNOWN, BROWSE, FILM, PERSON_LANE, PAUSED, REMOVED }

data class UiState(
    val source: Source = Source.NONE,
    val link: Link = Link.OFF,
    val registered: Boolean = false,
    val deviceName: String = "",
    val hasDisplay: Boolean = false,
    val worn: Boolean? = null,
    val battery: Int? = null,
    val hot: Boolean = false,
    val cameraReady: Boolean = false,
    val listening: Boolean = false,
    val serverUrl: String = "",
    val online: Boolean = false,
    val recogniser: String = "",
    val wearerName: String = "",
    val consentGiven: Boolean = false,
    /** The family switched on noting heart rate, and the latest reading while it is being read. */
    val heartOn: Boolean = false,
    val heartBpm: Int? = null,
    val heartSource: String = "",
    /** Simulated glasses only: the rate set on this phone for their motion to carry, or null for automatic. */
    val heartSetBpm: Int? = null,
    val keepsakes: List<Keepsake> = emptyList(),
    val phase: Phase = Phase.OFF,
    val currentKeepsake: String? = null,
    val paused: Boolean = false,
    val autoLook: Boolean = false,
    val listenForVoice: Boolean = false,
    val heard: String = "",
    val notice: String? = null,
    val lastLookMs: Long? = null,
    val chromePreview: String? = null,
    val log: List<String> = emptyList(),
)

private const val TAG = "MemoryLane"
private const val FRAME_MAX_PX = 768
private const val DISPLAY_PHOTO_MAX_PX = 360
private const val MEMORY_IDLE_MS = 90_000L

/** Each step of moving the story on a line: the old line dims, the new one comes in, it brightens. */
private const val STORY_STEP_MS = 300L

/** How long a character of the story takes to say, for a recording that does not give its length. */
private const val STORY_MS_PER_CHAR = 70L
/** Auto-look interval. Each look is one model call, and the model key is on a free tier with a daily cap. */
private const val AUTO_LOOK_EVERY_MS = 30_000L
/** At or below this the wearer is warned, and the phone shows the battery in red. */
const val LOW_BATTERY = 15
private const val MAX_RECONNECTS = 3

/** Push to talk: how long the microphone stays open after the press, or after the last word heard. */
private const val TALK_WINDOW_MS = 8_000L

private val LOOK_PHRASES =
    Regex("what('s| is|s) (this|that)|tell me about (this|that)|what am i holding|whose is (this|that)")
/**
 * "What is this?" as speech recognition often gets it wrong: "what is his birth card", "what is
 * it". Taken as a look only when nothing is on the display, so "what's his name?" about someone
 * shown is still a question.
 */
private val MISHEARD_LOOK = Regex("^what(?:'s| is|s) (?:his|it)\\b")
/** A question about something in front of the wearer: "where did this come from?" */
private val POINTS_AT = Regex("\\b(this|that|these|those)\\b")
/** "Who's Maya?": asking about someone by name. What follows is checked against the family. */
private val WHO_NAMED = Regex("^who(?:'s|se| is|s) (.+)$")
private val WHO_PHRASES = Regex("who('s| is|s) (that|this|he|she|it)|who are you|do i know (you|him|her|them)")
private val QUESTION_START =
    Regex("^(who|what|where|when|why|how|is|are|am|do|does|did|can|could|will|would|has|have|should)\\b")
private const val OFFER_WAIT_MS = 25_000L

/**
 * Closing a video makes the toolkit wipe the display without waiting to hear that it has. A
 * screen sent in the same instant as that wipe is acknowledged can lose its own answer, and the
 * send then never returns. This long after closing, the wipe is over (it takes about 30 ms).
 */
private const val DISPLAY_SETTLE_MS = 300L

/**
 * A screen that has had no answer in this long is given up on, so later ones are not held up.
 * The toolkit can miss the answer to a screen it did deliver (seen on a busy emulator: the
 * answer arrived before the toolkit had finished sending), and would otherwise wait on it.
 */
private const val DISPLAY_SEND_TIMEOUT_MS = 2_500L
/** How long a memory stays on the display before its person's memory lane is offered. */
private const val AFTER_MEMORY_MS = 3_000L
private const val LANE_MOMENT_MS = 7_000L
/** Rates the simulated glasses can be set to: inside what PulseEstimator reads (42 to 150). */
private val SIM_BPM_RANGE = 45..145
private val LANE_PHRASES = Regex("memory lane|(show|play) me (my|our|the) memories")
private val STOP_PHRASES = setOf("stop", "done", "that's enough", "thats enough", "go back", "thank you", "thanks")

/**
 * Runs the loop on the glasses: look, recognise, play the family's memory, answer questions.
 * It also owns every way that loop can be interrupted: glasses taken off, a dropped link,
 * no network, a low battery, a privacy pause.
 */
class GlassesViewModel(app: Application) : AndroidViewModel(app) {
  private val repo = Repository(app)
  private val narrator = Narrator(app)

  private val _ui = MutableStateFlow(UiState(serverUrl = repo.baseUrl, listenForVoice = repo.listenForVoice))
  val ui: StateFlow<UiState> = _ui.asStateFlow()

  private val _mockDisplay = MutableStateFlow<MockDisplayKit?>(null)
  val mockDisplay: StateFlow<MockDisplayKit?> = _mockDisplay.asStateFlow()

  /** Simulated glasses only: what the camera sees, compressed, drawn behind the lens preview. */
  val cameraFeed = CameraFeed()

  private var pack: Pack? = repo.cachedPack()
  private var mockGlasses: MockGlasses? = null
  private var selector: DeviceSelector? = null
  private var session: DeviceSession? = null
  private var camera: Camera? = null
  private var display: Display? = null
  private var speech: Speech? = null

  /** Everything observing the current session. Cancelled as one when the session goes. */
  private var sessionJob: Job? = null

  /** The one thing being done for the wearer right now. Starting another replaces it. */
  private var actionJob: Job? = null
  private var autoJob: Job? = null
  private var cameraJob: Job? = null
  private var speechJob: Job? = null
  private var inputsJob: Job? = null

  /** Push to talk: set while the microphone is open for one thing said, and closes it when it runs out. */
  private var talkJob: Job? = null

  private val displayLock = Mutex()
  private var currentScreen: Screen? = null
  /** The latest screen on its way to the display. Sends go in the order they were asked for. */
  private var showJob: Job? = null
  private var reconnects = 0
  private var warnedLowBattery = false
  private var wearablesReady = false
  private var testFrame: String? = null

  /** The memory on offer, waiting for the wearer to say yes or choose "See memory". */
  private var offered: Keepsake? = null

  /** How sure the speech recogniser was of the last thing heard, sent with a question it asks. */
  private var heardConfidence: Float? = null

  /** The person whose memory lane is on offer ("yes" walks it). */
  private var offeredLane: Person? = null

  private val heart = HeartMonitor()
  /** Simulated glasses only: the resting rate in the motion they replay, and the last resort. */
  private val mockRestingBpm = 62.0 + Random.nextInt(10)
  private val madeUpHeart = SimulatedHeartSource()
  /** Simulated glasses only: whether a memory is open, so a rate set by hand replays the right recording. */
  @Volatile private var mockMemoryOpen = false

  init {
    applyPack()
    viewModelScope.launch { serverLoop() }
    // Heart rate is read only while the glasses are connected and the family has switched it on.
    viewModelScope.launch {
      ui.map { it.heartOn && it.link == Link.READY }.distinctUntilChanged().collectLatest { on ->
        heart.clear()
        val simulated = _ui.value.source == Source.SIMULATED
        _ui.update { it.copy(heartBpm = null, heartSource = if (simulated) HEART_SIMULATED else HEART_FROM_GLASSES) }
        val current = session
        if (!on || current == null) return@collectLatest
        if (simulated) replayMockMotion(memoryOpen = false)
        // Real glasses: the pulse comes from their motion or not at all. Nothing is made up.
        val heard = pulseFromMotion(current, giveUpAfterMs = if (simulated) 30_000 else null)
        if (!heard && simulated) {
          log("The simulated glasses gave no motion to read a pulse from. Using made-up readings.")
          madeUpHeart.readings.collect(::onHeartReading)
        }
      }
    }
    // One heart-rate session for each time a memory is open, sent with the other events.
    viewModelScope.launch {
      var open: String? = null
      ui.map { it.phase to it.currentKeepsake }.distinctUntilChanged().collect { (phase, id) ->
        val now =
            when {
              phase == Phase.MEMORY || phase == Phase.FILM -> id
              // A question about the memory, or asking who someone is, does not close it.
              open != null && (phase == Phase.ANSWERING || phase == Phase.PERSON) -> open
              else -> null
            }
        if (now == open) return@collect
        val simulated = _ui.value.source == Source.SIMULATED
        open?.let { closed ->
          val session = heart.end(_ui.value.heartSource)
          if (session != null) {
            repo.queueEvent("heart_response", closed, session)
            log("Heart rate noted for that memory")
          } else if (_ui.value.heartOn) {
            log("No heart rate for that memory: too few steady readings")
          }
          if (simulated && _ui.value.heartOn) {
            madeUpHeart.memoryClosed()
            replayMockMotion(memoryOpen = false)
          }
        }
        open = now
        if (now != null && _ui.value.heartOn) {
          heart.begin()
          if (simulated) {
            madeUpHeart.memoryOpened()
            replayMockMotion(memoryOpen = true)
          }
        }
      }
    }
    viewModelScope.launch {
      var last: Pair<Phase, String?>? = null
      ui.collect { state ->
        val now = state.phase to state.currentKeepsake
        if (now != last) {
          last = now
          Log.i(TAG, "Phase ${state.phase}" + (state.currentKeepsake?.let { " $it" } ?: ""))
        }
      }
    }
  }

  // ---- Heart rate from the glasses' motion -----------------------------------------------

  private fun onHeartReading(bpm: Int) {
    heart.add(bpm)
    _ui.update { it.copy(heartBpm = bpm) }
  }

  /**
   * Streams the glasses' accelerometer and gyroscope and reads a pulse from them, until
   * cancelled. Returns false if motion could not be started, or (with [giveUpAfterMs]) if no
   * pulse was found in that time. Motion is an experimental part of the toolkit and has to be
   * enabled for the app in the Wearables Developer Center.
   */
  private suspend fun pulseFromMotion(current: DeviceSession, giveUpAfterMs: Long?): Boolean {
    val motion =
        current.addMotion(MotionConfiguration(MotionSamplingRate.HZ_60)).let { added ->
          added.onFailure { error, _ -> log("No motion sensors: ${error.description}. Heart rate is not being read.") }
          added.getOrNull()
        } ?: return false
    val heard = java.util.concurrent.atomic.AtomicBoolean(false)
    try {
      return coroutineScope {
        val reading =
            launch(Dispatchers.Default) {
              val estimator = PulseReader()
              var quiet = 0
              var rateKnown = false
              motion.samples.collect { sample ->
                // A Neural Band sends its own motion on the same stream. A wrist is not a head.
                if (sample.source == MotionSource.NEURAL_BAND) return@collect
                val a = sample.accelerometer ?: return@collect
                val g = sample.gyroscope ?: return@collect
                val before = estimator.reason
                val bpm = estimator.add(sample.timestampNs, a.x.toDouble(), a.y.toDouble(), a.z.toDouble(), g.x.toDouble(), g.y.toDouble(), g.z.toDouble())
                if (!rateKnown && estimator.rate > 0) {
                  rateKnown = true
                  log(
                      if (estimator.tooSlow) "Motion is arriving at ${estimator.rate.roundToInt()} samples a second, too few to read a pulse from."
                      else "Motion is arriving at ${estimator.rate.roundToInt()} samples a second",
                  )
                }
                if (bpm != null) {
                  if (!heard.getAndSet(true)) log("Reading a pulse from the glasses' motion: $bpm beats a minute")
                  quiet = 0
                  onHeartReading(bpm)
                } else if (estimator.reason.isNotEmpty() && (estimator.reason != before || ++quiet == 60 * 5)) {
                  // No reading for five seconds, or for a new reason: stop showing the old one.
                  _ui.update { it.copy(heartBpm = null) }
                }
              }
            }
        launch { motion.state.collect { Log.i(TAG, "Motion $it") } }
        motion.start()
        if (giveUpAfterMs != null) {
          delay(giveUpAfterMs)
          if (!heard.get()) {
            coroutineContext.cancelChildren()
            return@coroutineScope false
          }
        }
        reading.join()
        true
      }
    } finally {
      runCatching {
        motion.stop()
        current.removeMotion()
      }
    }
  }

  /**
   * Simulated glasses have no head to measure, so Mock Device Kit replays made-up head motion
   * with a heartbeat in it. While a memory is open the recording's rate climbs and settles
   * again, three times in four. The pulse is still read from that motion by the same code that
   * reads real glasses. A rate set on the phone ([simulateHeart]) is carried as it is, with no
   * rise of its own.
   */
  private fun replayMockMotion(memoryOpen: Boolean) {
    mockMemoryOpen = memoryOpen
    val glasses = mockGlasses ?: return
    val set = _ui.value.heartSetBpm
    viewModelScope.launch(Dispatchers.Default) {
      val recording =
          if (set != null) {
            mockMotionRecording(60, set.toDouble())
          } else if (memoryOpen) {
            val rise = if (Random.nextInt(4) < 3) 10.0 + Random.nextInt(9) else 0.0
            mockMotionRecording(120, mockRestingBpm, riseBy = rise, peakAtSec = 16.0 + Random.nextInt(8))
          } else {
            mockMotionRecording(60, mockRestingBpm)
          }
      runCatching { glasses.services.motion.setMotionFeed(recording, true) }
          .onFailure { log("Could not replay simulated motion: ${it.message}") }
    }
  }

  // ---- Server, pack and connectivity -----------------------------------------------------

  private suspend fun serverLoop() {
    while (viewModelScope.isActive) {
      checkServer()
      delay(20_000)
    }
  }

  private suspend fun checkServer() {
    try {
      val health = repo.health()
      val wasOffline = !_ui.value.online
      _ui.update { it.copy(online = true, recogniser = health.optString("recogniser")) }
      if (wasOffline) log("Server reachable")
      if (health.optString("packVersion") != pack?.version) {
        pack = repo.syncPack()
        applyPack()
        log("Memories updated: ${pack?.keepsakes?.size ?: 0} on this phone")
        // Consent may just have been recorded in the family app.
        if (_ui.value.phase == Phase.NEEDS_CONSENT && pack?.wearerAgreed == true) goHome()
      }
      runCatching { repo.flushEvents() }
    } catch (e: Offline) {
      if (_ui.value.online) log("Server unreachable: ${e.message}")
      _ui.update { it.copy(online = false) }
    }
  }

  private fun applyPack() {
    val current = pack
    _ui.update {
      it.copy(
          wearerName = current?.wearerName.orEmpty(),
          consentGiven = current?.wearerAgreed == true,
          heartOn = current?.wearerAgreed == true && current.heartRate,
          keepsakes = current?.keepsakes.orEmpty(),
      )
    }
  }

  /** From the QR code in the family app (a memorylane://pair link). */
  fun pair(server: String, code: String) {
    repo.accessCode = code
    log("Paired with ${server.trim()}")
    setServerUrl(server)
  }

  fun setServerUrl(url: String) {
    repo.baseUrl = url
    _ui.update { it.copy(serverUrl = repo.baseUrl, online = false) }
    syncNow()
  }

  fun syncNow() {
    // Forget the cached version so the next check downloads again.
    pack = pack?.copy(version = "")
    viewModelScope.launch { checkServer() }
  }

  // ---- Connecting ------------------------------------------------------------------------

  fun onWearablesReady() {
    if (wearablesReady) return
    wearablesReady = true
    viewModelScope.launch {
      Wearables.registrationState.collect { state ->
        _ui.update { it.copy(registered = state == RegistrationState.REGISTERED) }
      }
    }
  }

  private fun granted(permission: String) =
      getApplication<Application>().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  fun connect(simulated: Boolean) {
    if (_ui.value.source != Source.NONE) return
    if (!simulated) {
      _ui.update { it.copy(source = Source.REAL) }
      // Display is used when the glasses have one. Without it the same loop runs by ear.
      startSession(AutoDeviceSelector())
      return
    }

    _ui.update { it.copy(source = Source.SIMULATED, link = Link.CONNECTING) }
    val cameraAllowed = granted(Manifest.permission.CAMERA)
    val liveMicrophone = repo.listenForVoice && granted(Manifest.permission.RECORD_AUDIO)
    viewModelScope.launch {
      val kit = MockDeviceKit.getInstance(getApplication())
      // Pairing a simulated pair takes a noticeable moment; keep it off the UI thread.
      val paired =
          withContext(Dispatchers.Default) {
            runCatching {
              kit.enable()
              kit.pairGlasses(GlassesModel.META_RAYBAN_DISPLAY).getOrNull()?.also { glasses ->
                glasses.powerOn()
                glasses.unfold()
                glasses.don()
                // The phone's own camera and microphone stand in for the glasses'.
                if (cameraAllowed) glasses.services.camera.setCameraFeed(CameraFacing.BACK)
                if (liveMicrophone) {
                  glasses.services.speech.setTranscriptionSource(MockSpeechSource.LIVE_DEVICE_ASR)
                }
              }
            }
          }
      val glasses = paired.getOrNull()
      if (glasses == null) {
        runCatching { kit.disable() }
        _ui.update { it.copy(source = Source.NONE, link = Link.OFF) }
        notice("Could not start simulated glasses: ${paired.exceptionOrNull()?.message ?: "pairing failed"}")
        return@launch
      }
      if (!cameraAllowed) log("Phone camera not allowed: looking will fall back to the memory list")
      mockGlasses = glasses
      _mockDisplay.value = glasses.services.display
      // A pair that has just been switched on takes a moment to be listed as available.
      withTimeoutOrNull(10_000) { Wearables.devices.first { glasses.deviceIdentifier in it } }
      startSession(SpecificDeviceSelector(glasses.deviceIdentifier))
    }
  }

  private fun startSession(deviceSelector: DeviceSelector) {
    selector = deviceSelector
    _ui.update { it.copy(link = Link.CONNECTING) }
    Wearables.createSession(deviceSelector)
        .fold(
            onSuccess = { newSession ->
              session = newSession
              sessionJob?.cancel()
              // Subscribe before start() so no transition is missed.
              sessionJob =
                  viewModelScope.launch {
                    launch { newSession.state.collect { onSessionState(newSession, it) } }
                    launch {
                      newSession.errors.collect { error ->
                        log("Glasses: ${error.description}")
                        notice(error.description)
                      }
                    }
                    launch { newSession.deviceInfo.collect { onDevice(it) } }
                  }
              newSession.start()
            },
            onFailure = { error, _ ->
              // Often just "not available yet": glasses still waking, or out of reach for a
              // moment. Try a few more times before telling anyone.
              if (reconnects < MAX_RECONNECTS && _ui.value.source != Source.NONE) {
                reconnects++
                log("Glasses not available yet (${error.description}). Trying again.")
                viewModelScope.launch {
                  delay(2_000L * reconnects)
                  if (_ui.value.source != Source.NONE && session == null) startSession(deviceSelector)
                }
              } else {
                _ui.update { it.copy(link = Link.LOST) }
                notice("Can't reach the glasses: ${error.description}")
              }
            },
        )
  }

  private fun onSessionState(current: DeviceSession, state: DeviceSessionState) {
    if (current !== session) return
    log("Session $state")
    when (state) {
      DeviceSessionState.STARTED -> {
        reconnects = 0
        GlassesService.start(getApplication())
        if (_ui.value.link != Link.READY) {
          _ui.update { it.copy(link = Link.READY, notice = null) }
          attachCapabilities(current)
        }
      }
      DeviceSessionState.PAUSED ->
          // A call, a notification or Meta AI has the glasses. Wait; do not fight for them.
          notice("The glasses are busy with something else. Memory Lane will carry on after.")
      DeviceSessionState.STOPPED -> onSessionLost()
      else -> Unit
    }
  }

  private fun onSessionLost() {
    actionJob?.cancel()
    sessionJob?.cancel()
    cameraJob?.cancel()
    speechJob?.cancel()
    talkJob?.cancel()
    inputsJob?.cancel()
    session = null
    camera = null
    display = null
    speech = null
    _ui.update {
      it.copy(link = Link.LOST, cameraReady = false, listening = false, phase = Phase.OFF)
    }
    if (_ui.value.source == Source.NONE) return
    repo.queueEvent("connection_lost")
    val again = selector ?: return
    if (reconnects >= MAX_RECONNECTS) {
      notice("Lost the glasses. Check they are on and nearby, then reconnect.")
      return
    }
    reconnects++
    viewModelScope.launch {
      // A stopped session cannot be restarted; make a new one, backing off a little each time.
      delay(2_000L * reconnects)
      if (_ui.value.source != Source.NONE && session == null) {
        log("Reconnecting ($reconnects of $MAX_RECONNECTS)")
        startSession(again)
      }
    }
  }

  private fun attachCapabilities(current: DeviceSession) {
    val info = current.deviceInfo.value
    val hasDisplay = info.isDisplayCapable()
    _ui.update { it.copy(deviceName = info.name, hasDisplay = hasDisplay) }

    if (hasDisplay) {
      current
          .addDisplay()
          .fold(
              onSuccess = { newDisplay ->
                display = newDisplay
                sessionJob?.let { parent ->
                  viewModelScope.launch(parent) {
                    newDisplay.state.collect { state ->
                      // The display sleeps and wakes on its own; redraw whenever it comes up.
                      if (state == DisplayState.STARTED) currentScreen?.let { push(it) }
                    }
                  }
                }
              },
              onFailure = { error, _ -> log("No display: ${error.description}. Carrying on by ear.") },
          )
    } else {
      log("These glasses have no display. Running audio-first.")
    }
    attachCamera(current)
    if (repo.listenForVoice) attachSpeech(current)
    attachInputs(current)
    goHome()
  }

  private fun attachCamera(current: DeviceSession) {
    // Compressed frames keep flowing when the phone is in a pocket with the screen off. With
    // real glasses nothing draws this stream, so it is as slow as the SDK allows. With simulated
    // glasses it is drawn behind the lens preview, decoded by the phone's video decoder.
    val drawn = _ui.value.source == Source.SIMULATED
    current
        .addCamera(
            StreamConfiguration(
                videoQuality = VideoQuality.LOW,
                frameRate = if (drawn) 15 else 2,
                compressVideo = true,
            ),
        )
        .fold(
            onSuccess = { newCamera ->
              camera = newCamera
              cameraJob?.cancel()
              cameraJob =
                  viewModelScope.launch {
                    if (drawn) {
                      launch(Dispatchers.Default) {
                        try {
                          newCamera.stream.videoStream.collect(cameraFeed::push)
                        } finally {
                          cameraFeed.reset()
                        }
                      }
                    }
                    newCamera.stream.state.collect { state ->
                      _ui.update { it.copy(cameraReady = state == StreamState.STREAMING) }
                    }
                  }
              newCamera.stream.start().onFailure { error, _ -> log("Camera: ${error.description}") }
            },
            onFailure = { error, _ ->
              // Usually the camera permission was not granted in Meta AI. Memories can still
              // be opened from the list.
              log("No camera: ${error.description}")
            },
        )
  }

  private fun attachSpeech(current: DeviceSession) {
    current
        .addSpeech()
        .fold(
            onSuccess = { newSpeech ->
              speech = newSpeech
              speechJob?.cancel()
              speechJob =
                  viewModelScope.launch {
                    launch { newSpeech.transcriptions.collect { onHeard(it) } }
                    launch {
                      newSpeech.state.collect { state ->
                        _ui.update { it.copy(listening = state == SpeechState.STARTED) }
                      }
                    }
                  }
              // Not started: the microphone opens only for push to talk.
            },
            onFailure = { error, _ ->
              // Every spoken action also has a button, so this is a loss, not a blocker.
              log("No speech: ${error.description}. Buttons still work.")
            },
        )
  }

  /**
   * The capture button on the glasses is push to talk. Only that button is taken: choosing a
   * button on the lens (a tap on the touchpad, a pinch on the Neural Band) stays with the
   * display, as before.
   */
  private fun attachInputs(current: DeviceSession) {
    current
        .addInputs(InputsConfiguration(setOf(InputSource.CAPTURE_BUTTON), false))
        .fold(
            onSuccess = { newInputs ->
              inputsJob?.cancel()
              inputsJob =
                  viewModelScope.launch {
                    launch { newInputs.events.collect { if (it is InputEvent.Capture) pushToTalk() } }
                    launch { newInputs.errors.collect { error -> if (error != null) log("Capture button: ${error.description}") } }
                  }
            },
            onFailure = { error, _ ->
              // Every spoken action also has a button on the lens, and the phone has Talk.
              log("No capture button: ${error.description}")
            },
        )
  }

  /**
   * Push to talk. A press opens the microphone for one thing said: it closes on the first
   * finished sentence, after [TALK_WINDOW_MS] with nothing heard, or on a second press.
   * Anything playing stops first, so the microphone hears the wearer and not us.
   */
  fun pushToTalk() {
    val state = _ui.value
    if (state.link != Link.READY || state.paused) return
    val current = speech
    if (current == null) {
      log(if (repo.listenForVoice) "Talk pressed, but speech is not available" else "Talk pressed, but listening is off")
      if (!repo.listenForVoice) notice("Spoken questions are off. They can be turned on under More.")
      return
    }
    if (talkJob?.isActive == true) {
      log("Talk: closed by a second press")
      stopTalking()
      return
    }
    if (narrator.isAudible()) actionJob?.cancel()
    current.start().fold(
        onSuccess = {
          log("Talk: listening")
          keepTalkOpen()
        },
        onFailure = { error, _ -> log("Listening: ${error.description}") },
    )
  }

  private fun keepTalkOpen() {
    talkJob?.cancel()
    talkJob =
        viewModelScope.launch {
          delay(TALK_WINDOW_MS)
          log("Talk: heard nothing")
          stopTalking()
        }
  }

  private fun stopTalking() {
    talkJob?.cancel()
    talkJob = null
    runCatching { speech?.stop() }
  }

  private fun detachSpeech(current: DeviceSession) {
    talkJob?.cancel()
    talkJob = null
    speechJob?.cancel()
    runCatching { speech?.stop() }
    runCatching { current.removeSpeech() }
    speech = null
    _ui.update { it.copy(listening = false) }
  }

  fun disconnect() {
    GlassesService.stop(getApplication())
    actionJob?.cancel()
    autoJob?.cancel()
    sessionJob?.cancel()
    cameraJob?.cancel()
    speechJob?.cancel()
    talkJob?.cancel()
    inputsJob?.cancel()
    selector = null
    runCatching { session?.removeInputs() }
    runCatching { session?.stop() }
    session = null
    camera = null
    display = null
    speech = null
    currentScreen = null
    mockGlasses?.let { glasses ->
      val kit = MockDeviceKit.getInstance(getApplication())
      runCatching {
        kit.stopTestServer()
        glasses.doff()
        glasses.powerOff()
        kit.unpairDevice(glasses)
        kit.disable()
      }
    }
    mockGlasses = null
    _mockDisplay.value = null
    madeUpHeart.fixedBpm = null
    _ui.update {
      UiState(
          serverUrl = it.serverUrl,
          online = it.online,
          recogniser = it.recogniser,
          registered = it.registered,
          wearerName = it.wearerName,
          consentGiven = it.consentGiven,
          heartOn = it.heartOn,
          keepsakes = it.keepsakes,
          log = it.log,
      )
    }
  }

  // ---- Device state ----------------------------------------------------------------------

  private fun onDevice(device: Device) {
    val worn =
        when (device.donState) {
          DonState.DONNED -> true
          DonState.DOFFED -> false
          else -> null
        }
    val before = _ui.value
    _ui.update {
      it.copy(
          deviceName = device.name,
          battery = device.batteryLevel.takeIf { level -> level in 0..100 },
          hot = device.thermalLevel.ordinal >= ThermalLevel.SEVERE.ordinal,
          worn = worn,
      )
    }
    if (before.link != Link.READY) return

    if (worn == false && before.worn != false) {
      // Off the face means nobody is watching or listening: stop mid-sentence.
      actionJob?.cancel()
      _ui.update { it.copy(phase = Phase.REMOVED) }
      show(messageScreen("Paused", ""))
      repo.queueEvent("glasses_removed")
      log("Glasses taken off: paused")
    } else if (worn == true && before.worn == false) {
      log("Glasses back on")
      goHome()
    }

    val level = device.batteryLevel
    if (level in 0..LOW_BATTERY && !warnedLowBattery) {
      warnedLowBattery = true
      repo.queueEvent("low_battery")
      notice("Glasses battery is at $level%.")
      if (_ui.value.phase == Phase.IDLE) {
        viewModelScope.launch { narrator.say("Your glasses will need charging soon.") }
      }
    } else if (level > LOW_BATTERY + 10) {
      warnedLowBattery = false
    }
  }

  // ---- The display -----------------------------------------------------------------------

  private fun show(screen: Screen) {
    currentScreen = screen
    showJob = viewModelScope.launch { push(screen) }
  }

  private suspend fun push(screen: Screen) {
    val target = display ?: return
    // Each send replaces the whole display, so they must not interleave.
    displayLock.withLock {
      withContext(Dispatchers.IO) {
        val sent = withTimeoutOrNull(DISPLAY_SEND_TIMEOUT_MS) { runCatching { target.sendContent(screen) } }
        if (sent == null) Log.w(TAG, "display: no answer to a screen")
        sent?.onSuccess { result -> result.onFailure { error, _ -> Log.w(TAG, "display: ${error.description}") } }
            ?.onFailure { Log.w(TAG, "display send failed", it) }
      }
    }
  }

  /** Display callbacks arrive off the main thread; everything here runs on it. */
  private fun onMain(action: () -> Unit): () -> Unit = { viewModelScope.launch { action() } }

  fun goHome() {
    actionJob?.cancel()
    offered = null
    offeredLane = null
    if (_ui.value.link != Link.READY) return
    if (pack?.wearerAgreed != true) {
      needConsent()
      return
    }
    _ui.update { it.copy(phase = Phase.IDLE, currentKeepsake = null) }
    show(
        homeScreen(
            wearerName = _ui.value.wearerName,
            canListen = speech != null,
            onLook = onMain { look() },
            onBrowse = onMain { browse("") },
        ),
    )
  }

  private fun needConsent() {
    _ui.update { it.copy(phase = Phase.NEEDS_CONSENT) }
    show(messageScreen("Not set up yet", "Your family can finish setting up."))
    notice("The wearer's agreement hasn't been recorded yet. In the family app, open Privacy and agreement.")
  }

  // ---- Looking ---------------------------------------------------------------------------

  fun look(hint: String? = null) = look(hint, quiet = false)

  /**
   * "Who is that?": the same look, but the answer leads with the person. [asked] is what the
   * wearer said after "who is" ("the girl"), to pick out one of the people in the memory.
   */
  fun lookForPerson(asked: String = "") = look(hint = null, quiet = false, who = true, asked = asked)

  /**
   * "Where did this come from?" with no memory open: look first, then ask about the
   * memory in view. Nothing recognised, it is asked as an everyday question.
   */
  private fun lookThenAsk(question: String) = look(hint = null, quiet = false, question = question)

  private fun look(hint: String?, quiet: Boolean, who: Boolean = false, asked: String = "", question: String? = null) {
    val state = _ui.value
    if (state.link != Link.READY || state.paused || state.worn == false) return
    if (state.phase == Phase.LOOKING) return
    if (pack?.wearerAgreed != true) {
      needConsent()
      return
    }
    actionJob?.cancel()
    actionJob =
        viewModelScope.launch {
          _ui.update { it.copy(phase = Phase.LOOKING) }
          if (!quiet) {
            show(lookingScreen())
            // Said straight away so the wait for the answer is never silent.
            launch { narrator.say("Let me have a look.") }
          }
          val frame = captureFrame()
          if (frame == null && hint == null) {
            log("Could not take a picture")
            if (quiet) goHome() else browse("I can't see just now. Here are your memories.")
            return@launch
          }
          val result =
              try {
                repo.recognise(frame ?: "A".repeat(128), hint)
              } catch (e: ConsentRequired) {
                needConsent()
                return@launch
              } catch (e: Offline) {
                log("Could not look: ${e.message}")
                _ui.update { it.copy(online = false) }
                if (quiet) {
                  goHome()
                } else {
                  repo.queueEvent("connection_lost")
                  browse("I can't look right now. Here are your memories.")
                }
                return@launch
              }
          _ui.update { it.copy(lastLookMs = result.latencyMs, online = true) }
          log("Looked in ${result.latencyMs} ms: ${result.matchId ?: "no match (${result.objectLabel})"}")

          var keepsake = pack?.keepsake(result.matchId)
          if (keepsake == null && result.matchId != null) {
            // Added in the family app since the last sync.
            runCatching { pack = repo.syncPack() }
            applyPack()
            keepsake = pack?.keepsake(result.matchId)
          }
          when {
            question != null -> {
              keepsake?.let { k -> _ui.update { it.copy(currentKeepsake = k.id) } }
              answer(question, keepsake)
            }
            // "Who's that?" with a memory in view: the person meant says hello, then the memory
            // is offered.
            keepsake != null && who && peopleIn(keepsake).isNotEmpty() -> answerWho(keepsake, asked)
            // Asked for ("What's this?"): the memory opens straight away. Only a look nobody
            // asked for is offered first.
            keepsake != null -> if (quiet || who) offerMemory(keepsake) else playMemory(keepsake)
            quiet -> goHome()
            who -> {
              // Nobody the family has introduced. Say so plainly; never guess at a stranger.
              _ui.update { it.copy(phase = Phase.UNKNOWN) }
              show(messageScreen("I'm not sure who that is", "", primary = "Done" to onMain { goHome() }))
              narrator.say("I'm not sure who that is.")
              log("Did not know who that was")
              delay(15_000)
              goHome()
            }
            else -> unknownObject(result.objectLabel)
          }
        }
  }

  /** One still from the glasses, shrunk before it leaves the phone. */
  private suspend fun captureFrame(): String? {
    val stream = camera?.stream ?: return null
    val photo = withTimeoutOrNull(6_000) { stream.capturePhoto().getOrNull() } ?: return null
    testFrame?.let { return it }
    return withContext(Dispatchers.Default) {
      val bitmap =
          when (photo) {
            is PhotoData.Bitmap -> photo.bitmap
            is PhotoData.HEIC -> {
              val bytes = ByteArray(photo.data.remaining()).also { photo.data.get(it) }
              BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            }
            else -> null
          } ?: return@withContext null
      val out = ByteArrayOutputStream()
      scaled(bitmap, FRAME_MAX_PX).compress(Bitmap.CompressFormat.JPEG, 80, out)
      Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
  }

  private fun scaled(bitmap: Bitmap, maxPx: Int): Bitmap {
    val longest = maxOf(bitmap.width, bitmap.height)
    if (longest <= maxPx) return bitmap
    val ratio = maxPx.toFloat() / longest
    return Bitmap.createScaledBitmap(bitmap, (bitmap.width * ratio).toInt(), (bitmap.height * ratio).toInt(), true)
  }

  /**
   * Centre-crops to a wide strip. A full-height photo pushes the caption and the buttons off
   * the 600x600 display, and the wearer should never have to scroll to find "Done".
   */
  private fun banner(bitmap: Bitmap): Bitmap {
    val height = (bitmap.width / 2.2f).toInt()
    if (height >= bitmap.height) return bitmap
    return Bitmap.createBitmap(bitmap, 0, (bitmap.height - height) / 2, bitmap.width, height)
  }

  private suspend fun unknownObject(label: String) {
    _ui.update { it.copy(phase = Phase.UNKNOWN) }
    val looksLike = if (label.isBlank()) "" else "It looks like $label."
    show(
        messageScreen(
            "I don't know this one yet",
            "",
            primary = "Try again" to onMain { look() },
        ),
    )
    narrator.say("I don't have a memory about this yet. $looksLike".trim())
    log("Said it holds no memory yet")
    delay(20_000)
    goHome()
  }

  private fun browse(note: String) {
    val keepsakes = pack?.keepsakes.orEmpty()
    actionJob?.cancel()
    _ui.update { it.copy(phase = Phase.BROWSE) }
    repo.queueEvent("browse_opened")
    if (keepsakes.isEmpty()) {
      show(messageScreen("No memories yet", "Your family can add some.", primary = "Back" to onMain { goHome() }))
    } else {
      show(
          browseScreen(
              keepsakes,
              note,
              onOpen = { keepsake -> viewModelScope.launch { openKeepsake(keepsake.id) } },
              onBack = onMain { goHome() },
          ),
      )
    }
    if (note.isNotBlank()) actionJob = viewModelScope.launch { narrator.say(note) }
  }

  // ---- Memories --------------------------------------------------------------------------

  fun openKeepsake(id: String) {
    val keepsake = pack?.keepsake(id) ?: return
    if (_ui.value.link != Link.READY || _ui.value.paused) return
    actionJob?.cancel()
    actionJob = viewModelScope.launch { playMemory(keepsake) }
  }

  private suspend fun loadPhoto(keepsake: Keepsake): Bitmap? =
      withContext(Dispatchers.IO) {
        val file = repo.localFile(keepsake.memoryPhotos.firstOrNull())
        file?.let { BitmapFactory.decodeFile(it.path) }?.let { banner(scaled(it, DISPLAY_PHOTO_MAX_PX)) }
      }

  /**
   * Something with a memory is in view. It is offered, not played: the wearer may simply be
   * tidying up, and a voice starting unasked can startle.
   */
  private suspend fun offerMemory(keepsake: Keepsake) {
    offered = keepsake
    _ui.update { it.copy(phase = Phase.OFFER, currentKeepsake = keepsake.id) }
    val from = keepsake.from.ifBlank { pack?.person(keepsake.addedBy)?.name.orEmpty() }
    show(
        offerScreen(
            title = keepsake.name,
            from = from,
            onSee = onMain { acceptOffer() },
            onWho = whoButton(keepsake),
            onNotNow = onMain { goHome() },
        ),
    )
    log("Offered: ${keepsake.name}")
    narrator.say(
        if (from.isBlank()) "There's a memory here. Would you like to see it?"
        else "There's a memory here from $from. Would you like to see it?",
    )
    delay(OFFER_WAIT_MS)
    goHome()
  }

  /** The wearer chose "See memory", or said yes. */
  fun acceptOffer() {
    val keepsake = offered ?: return
    offered = null
    actionJob?.cancel()
    actionJob = viewModelScope.launch { playMemory(keepsake) }
  }

  /** The person's own recording if they made one, otherwise their written line. */
  private suspend fun sayHello(person: Person) {
    // Their video on the display with their recording by ear, if the family put it on the
    // glasses. The person's name and words go back on the display afterwards.
    val clip = person.filmVideo
    if (clip != null && showFilm(clip, recordingSource(person.filmAudio))) {
      currentScreen?.let { push(it) }
      log("Said who ${person.name} is (video)")
      return
    }
    val recording = recordingSource(person.introAudio)
    val played = recording != null && narrator.play(recording)
    if (!played) {
      narrator.say(
          person.introText.ifBlank {
            if (person.relationship.isBlank()) "This is ${person.name}."
            else "This is ${person.name}, your ${person.relationship.lowercase()}."
          },
      )
    }
    log("Said who ${person.name} is")
  }

  /** The relatives the family said are in a memory. */
  private fun peopleIn(keepsake: Keepsake) = keepsake.people.mapNotNull { pack?.person(it) }

  /**
   * Who "who's that?" means for a memory, with nothing more said: the person who added it, if
   * they are in it, or else the first person the family said is in it.
   */
  private fun ownerIn(keepsake: Keepsake): Person? =
      peopleIn(keepsake).let { people -> people.firstOrNull { it.id == keepsake.addedBy } ?: people.firstOrNull() }

  /** "Who's that?" on the display, for a memory with people in it. */
  private fun whoButton(keepsake: Keepsake): (() -> Unit)? =
      if (peopleIn(keepsake).isEmpty()) null
      else
          onMain {
            actionJob?.cancel()
            actionJob = viewModelScope.launch { answerWho(keepsake, "") }
          }

  /**
   * "Who's that ...?" about a memory with people in it. Just "who's that?" is the person whose
   * memory it is. More said ("who's that girl?") is whoever alone fits it; if nobody does, or
   * more than one could, the wearer is told plainly. Nobody is guessed at.
   */
  private suspend fun answerWho(keepsake: Keepsake, asked: String) {
    val person = whoIsMeant(asked, peopleIn(keepsake), ownerIn(keepsake))
    if (person != null) introducePerson(keepsake, person) else notSureWho(keepsake)
  }

  /**
   * One person in the memory says hello in their own words, and their memory lane is offered if
   * they have one. The memory itself stays on offer ("See memory", or "yes").
   */
  private suspend fun introducePerson(keepsake: Keepsake, person: Person) {
    offered = keepsake
    // Someone introduced before may have had a lane on offer; "yes" must not walk theirs.
    offeredLane = null
    _ui.update { it.copy(phase = Phase.PERSON, currentKeepsake = keepsake.id) }
    show(personScreen(person, onSee = onMain { acceptOffer() }, onDone = onMain { goHome() }))
    sayHello(person)
    log("Introduced: ${person.name}")
    if (person.lane.isNotEmpty()) offerLane(person)
    delay(OFFER_WAIT_MS)
    goHome()
  }

  /** Asked about someone in a memory who cannot be told apart. The memory stays on offer. */
  private suspend fun notSureWho(keepsake: Keepsake) {
    offered = keepsake
    offeredLane = null
    _ui.update { it.copy(phase = Phase.PERSON, currentKeepsake = keepsake.id) }
    show(
        messageScreen(
            "I'm not sure who that is",
            "",
            primary = "See memory" to onMain { acceptOffer() },
            secondary = "Done" to onMain { goHome() },
        ),
    )
    narrator.say("I'm not sure who that is.")
    log("Did not know who that was in ${keepsake.name}")
    delay(OFFER_WAIT_MS)
    goHome()
  }

  // ---- Memory lane -------------------------------------------------------------------------

  /**
   * Asked once someone has said hello: would the wearer like to walk through that person's
   * memories? "Yes", or the button, starts it. Nothing plays unasked.
   */
  private suspend fun offerLane(person: Person) {
    offered = null
    offeredLane = person
    val first = person.name.substringBefore(' ')
    _ui.update { it.copy(phase = Phase.PERSON) }
    show(laneOfferScreen(first, onYes = onMain { acceptLane() }, onNotNow = onMain { goHome() }))
    log("Offered memory lane: ${person.name}")
    narrator.say("Would you like to walk down memory lane with $first?")
  }

  /** The wearer said yes to a memory lane, or chose it. */
  fun acceptLane() {
    val person = offeredLane ?: return
    walkLane(person)
  }

  /** The phone's own button, and tests: walk a person's memory lane without the question. */
  fun openLane(personId: String) {
    val person = pack?.person(personId)?.takeIf { it.lane.isNotEmpty() } ?: return
    if (_ui.value.link != Link.READY || _ui.value.paused) return
    walkLane(person)
  }

  /**
   * Walks a memory lane: each moment's year and title are said, then its clip plays on the
   * display, as a memory's film does (on simulated glasses, on the lens drawn on this phone).
   * With no display the moments are told one after another.
   */
  private fun walkLane(person: Person) {
    actionJob?.cancel()
    offeredLane = null
    actionJob =
        viewModelScope.launch {
          _ui.update { it.copy(phase = Phase.PERSON_LANE, currentKeepsake = null) }
          log("Memory lane started: ${person.name}")
          person.lane.forEach { clip ->
            show(laneMomentScreen(clip.year, clip.title, onStop = onMain { goHome() }))
            narrator.say("${clip.year}. ${clip.title}.")
            val shown = clip.lens != null && showFilm(clip.lens, null)
            if (!shown) delay(LANE_MOMENT_MS)
            log("Memory lane moment: ${clip.year} ${clip.title}" + if (shown) " (video)" else "")
          }
          log("Memory lane finished: ${person.name}")
          delay(4_000)
          goHome()
        }
  }

  /**
   * "Who's Maya?": the relative asked about by name says hello in their own words. Nobody is
   * looked at: the name comes from the question. A memory that was open comes back afterwards.
   */
  private fun introduce(person: Person) {
    val phase = _ui.value.phase
    val open =
        if (phase == Phase.MEMORY || phase == Phase.ANSWERING) pack?.keepsake(_ui.value.currentKeepsake) else null
    actionJob?.cancel()
    actionJob =
        viewModelScope.launch {
          offered = null
          _ui.update { it.copy(phase = Phase.PERSON) }
          show(personScreen(person, onSee = null, onDone = onMain { goHome() }))
          sayHello(person)
          log("Introduced by name: ${person.name}")
          // Their memory lane is offered whether or not a memory was open: asking who someone
          // is at their own memory is the likeliest moment to want it.
          if (person.lane.isNotEmpty()) {
            offerLane(person)
            delay(OFFER_WAIT_MS)
          } else {
            delay(if (open != null) 4_000 else 15_000)
          }
          // Not taken up: back to the memory that was open, or home.
          if (open != null) {
            offeredLane = null
            showMemory(open)
            lingerThenHome()
          } else {
            goHome()
          }
        }
  }

  /** The memory on the display, with the opening of its story. */
  private suspend fun showMemory(keepsake: Keepsake) {
    val opening = storyLines(keepsake.story.ifBlank { keepsake.introLine }).firstOrNull().orEmpty()
    showMemoryLine(keepsake, loadPhoto(keepsake), opening, lit = false)
  }

  /** Returns once the line is on the display, so the time it is given starts when it is seen. */
  private suspend fun showMemoryLine(keepsake: Keepsake, photo: Bitmap?, line: String, lit: Boolean) {
    _ui.update { it.copy(phase = Phase.MEMORY, currentKeepsake = keepsake.id) }
    val screen =
        memoryScreen(
            keepsake = keepsake,
            photo = photo,
            line = line,
            lit = lit,
            canListen = speech != null,
            onQuestion = { answer -> viewModelScope.launch { ask(answer.question, answer) } },
            onWho = whoButton(keepsake),
            onDone = onMain { goHome() },
        )
    currentScreen = screen
    push(screen)
  }

  /**
   * Moves the story on by a line in a way that is easy to follow: nothing slides or scrolls.
   * The line just heard dims, the next takes its place still dim, then brightens as it is heard.
   * Everything else on the display stays where it was.
   */
  private suspend fun storyTo(keepsake: Keepsake, photo: Bitmap?, from: String, to: String) {
    showMemoryLine(keepsake, photo, from, lit = false)
    delay(STORY_STEP_MS)
    showMemoryLine(keepsake, photo, to, lit = false)
    delay(STORY_STEP_MS)
    showMemoryLine(keepsake, photo, to, lit = true)
  }

  /**
   * The memory lane if the family has put one on the glasses, with its own sound (the voice
   * message and music); otherwise the voice message on its own, with the family's story on the
   * display a line at a time as it plays.
   */
  private suspend fun playMemory(keepsake: Keepsake) {
    // The opening line is said while the film is fetched, not before it: the picture takes a
    // few seconds to arrive, and that wait is when the line is heard. The film's own sound
    // holds off until the line has finished.
    val filmed =
        keepsake.hasFilm &&
            coroutineScope {
              val intro = launch { narrator.say(keepsake.introLine) }
              runFilm(keepsake, after = intro)
            }
    if (filmed) {
      showMemory(keepsake)
      afterMemory(keepsake)
      return
    }
    if (!keepsake.hasFilm) narrator.say(keepsake.introLine)
    val photo = loadPhoto(keepsake)
    val story = storyLines(keepsake.story)
    showMemoryLine(keepsake, photo, story.firstOrNull() ?: keepsake.introLine, lit = false)
    val recording = recordingSource(keepsake.voiceNote)
    val played = recording != null && playWithStory(keepsake, photo, story, recording)
    // No recording (or it would not play): the family's written words in the neutral voice, a
    // line at a time, each on the display as it is read.
    if (!played) {
      story.forEachIndexed { i, line ->
        if (i == 0) showMemoryLine(keepsake, photo, line, lit = true) else storyTo(keepsake, photo, story[i - 1], line)
        narrator.say(line)
      }
    }
    // Finished: the last line stays, dimmed, until the wearer is done.
    story.lastOrNull()?.let { showMemoryLine(keepsake, photo, it, lit = false) }
    log("Memory played: ${keepsake.name}" + if (played) " (recording)" else " (read aloud)")
    afterMemory(keepsake)
  }

  /**
   * A memory has just been heard. If the person whose memory it is has a memory lane, the
   * wearer is asked whether they would like to walk it: "yes" or the button goes in, "no" or
   * waiting goes home. Otherwise the memory stays up for a while. Someone else in it is never
   * offered instead: Maya's birthday card is Maya's, even if Jake is in it and has a lane.
   */
  private suspend fun afterMemory(keepsake: Keepsake) {
    val person = (pack?.person(keepsake.addedBy) ?: ownerIn(keepsake))?.takeIf { it.lane.isNotEmpty() }
    if (person == null) {
      lingerThenHome()
      return
    }
    delay(AFTER_MEMORY_MS)
    offerLane(person)
    delay(OFFER_WAIT_MS)
    goHome()
  }

  /**
   * Plays the voice message with the story moving on beside it, each line given a share of the
   * recording by its length. The story is what the family wrote, not a transcript of the
   * recording, so it keeps pace with it rather than matching it word for word.
   */
  private suspend fun playWithStory(keepsake: Keepsake, photo: Bitmap?, story: List<String>, recording: String): Boolean {
    if (story.isEmpty()) return narrator.play(recording)
    return coroutineScope {
      val started = CompletableDeferred<Int>()
      val follow = launch {
        val total = story.sumOf { it.length }
        val length = started.await().toLong().takeIf { it > 0 } ?: (total * STORY_MS_PER_CHAR)
        showMemoryLine(keepsake, photo, story[0], lit = true)
        var before = 0
        for (i in 1 until story.size) {
          before += story[i - 1].length
          // Begin a step early, so the new line is in place as its share of the recording begins.
          val at = length * before / total - STORY_STEP_MS
          while ((narrator.position() ?: return@launch) < at) delay(150)
          storyTo(keepsake, photo, story[i - 1], story[i])
        }
      }
      val played = narrator.play(recording) { started.complete(it) }
      follow.cancelAndJoin()
      played
    }
  }

  /** A local copy if there is one, the server if it is reachable, otherwise nothing. */
  private fun recordingSource(path: String?): String? {
    if (path == null) return null
    return repo.localFile(path)?.path ?: repo.url(path).takeIf { _ui.value.online }
  }

  private suspend fun lingerThenHome() {
    delay(MEMORY_IDLE_MS)
    goHome()
  }

  /**
   * Plays a memory lane's glasses copy: the picture on the display, the sound by ear. With no
   * display, or no connection for the picture, the sound on its own. False if nothing played.
   */
  private suspend fun runFilm(keepsake: Keepsake, after: Job? = null): Boolean {
    _ui.update { it.copy(phase = Phase.FILM, currentKeepsake = keepsake.id) }
    repo.queueEvent("clip_watched", keepsake.id)
    val sound = recordingSource(keepsake.filmAudio)
    val clip = keepsake.filmVideo
    if (clip != null && display != null && _ui.value.online) {
      if (showFilm(clip, sound, after)) {
        log("Memory lane played: ${keepsake.name}")
        return true
      }
      log("The lane's video would not play. Sound only.")
    }
    if (sound == null) return false
    show(messageScreen(keepsake.name, "", primary = "Stop" to onMain { goHome() }))
    after?.join()
    val played = narrator.play(sound)
    log(if (played) "Memory lane played by ear: ${keepsake.name}" else "Memory lane could not play")
    return played
  }

  /**
   * A silent video on the display, with its sound by ear, until both have finished. False if
   * there is no display, no connection for the picture, or the picture did not start; nothing
   * has been heard in that case. The sound waits for [after], a line still being spoken.
   */
  private suspend fun showFilm(clip: String, sound: String?, after: Job? = null): Boolean {
    val target = display ?: return false
    if (!_ui.value.online) return false
    // A screen sent just before (the person's name, say) may still be on its way. Sent after the
    // video it would take its place, and the video would never start.
    showJob?.join()
    val player = VideoPlayer(source = VideoSource.Url(repo.url(clip)), codec = VideoCodec.MP4)
    var played = false
    try {
      val sent = displayLock.withLock { target.sendContent { video(player = player) } }
      // The sound starts when the picture does, so the voice stays with its pictures.
      val started =
          sent.isSuccess &&
              run {
                player.play()
                withTimeoutOrNull(8_000) { player.state.first { it == VideoPlayerState.PLAYING } } != null
              }
      if (!started) return false
      coroutineScope {
        val ear = async {
          after?.join()
          sound != null && narrator.play(sound)
        }
        withTimeoutOrNull(15 * 60_000L) { player.state.first { it == VideoPlayerState.ENDED } }
        ear.await()
      }
      played = true
      return true
    } finally {
      val stopped = !currentCoroutineContext().isActive
      withContext(NonCancellable) {
        // Closing the player wipes the display. Held under the lock, and for a moment after, so
        // no screen is sent until the wipe is over: see DISPLAY_SETTLE_MS.
        displayLock.withLock {
          runCatching { player.close() }
          delay(DISPLAY_SETTLE_MS)
        }
        // After a video that played, the caller draws what comes next. Otherwise (it did not
        // start, or the wearer stopped it) the screen that should be showing goes back, so the
        // display is never left empty.
        if (!played || stopped) currentScreen?.let { push(it) }
      }
    }
  }

  // ---- Questions -------------------------------------------------------------------------

  private fun localAnswer(answer: Answer) =
      AskResult(
          kind = if (answer.audio != null) "recorded" else "written",
          text = answer.text,
          speaker = answer.speaker,
          audio = answer.audio,
          say = if (answer.audio != null) null else if (answer.speaker.isBlank()) answer.text else "${answer.speaker} wrote: ${answer.text}",
      )

  /**
   * Answers a question with something the family recorded, or admits there is nothing yet.
   * With a memory open the question is taken to be about it; otherwise it is an everyday one.
   * [known] is set when the wearer chose a recorded question from the display.
   */
  /**
   * A question about the memory on the display (open, on offer, or one whose person is saying
   * hello), or an everyday one when there is none.
   */
  private fun ask(question: String, known: Answer? = null) {
    val phase = _ui.value.phase
    val keepsake =
        if (phase in setOf(Phase.MEMORY, Phase.ANSWERING, Phase.OFFER, Phase.PERSON)) pack?.keepsake(_ui.value.currentKeepsake)
        else null
    actionJob?.cancel()
    actionJob = viewModelScope.launch { answer(question, keepsake, known) }
  }

  private suspend fun answer(question: String, keepsake: Keepsake?, known: Answer? = null) {
    // Only a question just heard carries how sure the recogniser was; a chosen one does not.
    val confidence = heardConfidence.takeIf { known == null }.also { heardConfidence = null }
    _ui.update { it.copy(phase = Phase.ANSWERING) }
    val result =
        try {
          // Asked through the server even when the answer is already known, so the
          // family can notice a question that keeps coming back.
          repo.ask(keepsake?.id, question, confidence)
        } catch (e: java.io.IOException) {
          val candidates = keepsake?.answers.orEmpty() + pack?.answers.orEmpty()
          (known ?: matchAnswerOffline(question, candidates))?.let { localAnswer(it) }
              ?: AskResult("none", "", "", null, "I can't find an answer to that just now.")
        }
    log("Asked “$question”: ${result.kind}")
    val words = result.text.ifBlank { result.say.orEmpty() }
    val back = if (keepsake != null) onMain { openMemoryQuietly(keepsake) } else onMain { goHome() }
    show(answerScreen(question, words, result.speaker, onBack = back))

    val recording = if (result.kind == "recorded") recordingSource(result.audio) else null
    val played = recording != null && narrator.play(recording)
    if (!played) {
      narrator.say(
          result.say
              ?: if (result.speaker.isBlank()) result.text else "${result.speaker} said: ${result.text}",
      )
    }
    log("Answer given")
    // "This is from Maya.": then Maya says hello herself.
    pack?.person(result.personId)?.let { person ->
      show(personScreen(person, onSee = keepsake?.let { k -> onMain { openKeepsake(k.id) } }, onDone = back))
      sayHello(person)
    }
    if (keepsake != null) {
      delay(4_000)
      showMemory(keepsake)
      lingerThenHome()
    } else {
      delay(8_000)
      goHome()
    }
  }

  private fun openMemoryQuietly(keepsake: Keepsake) {
    actionJob?.cancel()
    actionJob =
        viewModelScope.launch {
          showMemory(keepsake)
          lingerThenHome()
        }
  }

  /** The relative a "who is …?" question names, if it names one. */
  private fun namedPerson(lower: String): Person? =
      WHO_NAMED.find(lower)?.groupValues?.get(1)?.let { pack?.personNamed(it) }

  /**
   * The memory open on the display, if the family said who is in it. Not one only on offer: by
   * then the wearer may have picked up something else, so the camera looks instead.
   */
  private fun memoryWithPeople(phase: Phase): Keepsake? =
      pack?.keepsake(_ui.value.currentKeepsake)?.takeIf { phase == Phase.MEMORY && peopleIn(it).isNotEmpty() }

  /** The person with a memory lane whose first name was said ("memory lane with Jake"). */
  private fun laneNamed(lower: String): Person? =
      pack?.people?.firstOrNull { it.lane.isNotEmpty() && lower.split(" ").contains(it.name.substringBefore(' ').lowercase()) }

  private fun looksLikeQuestion(lower: String) =
      lower.split(" ").size >= 3 && QUESTION_START.containsMatchIn(lower)

  private fun onHeard(result: TranscriptionResult?) {
    if (result == null) return
    // Words still coming in: keep the microphone open until the sentence is finished.
    if (!result.isFinal) {
      if (talkJob?.isActive == true) keepTalkOpen()
      return
    }
    // One thing said per press.
    stopTalking()
    val text = result.text.trim()
    if (text.isEmpty() || _ui.value.paused) return
    // The microphone hears the speakers. Anything picked up while we are talking is us.
    if (narrator.isAudible()) return
    _ui.update { it.copy(heard = text) }
    // Shown with how sure the recogniser was, so mishearings can be told apart from misroutes.
    heardConfidence = result.confidence.takeIf { it in 0f..1f }
    log("Heard “$text”" + (heardConfidence?.let { " (${(it * 100).roundToInt()}% sure)" } ?: ""))
    val lower = text.lowercase().trimEnd('.', '?', '!')

    val phase = _ui.value.phase
    when {
      lower in STOP_PHRASES -> goHome()
      // While a memory lane or a person's lane plays, only "stop" is listened for.
      phase == Phase.FILM || phase == Phase.PERSON_LANE -> Unit
      // "Memory lane with Jake": that person's lane, whatever is on the display.
      LANE_PHRASES.containsMatchIn(lower) && phase != Phase.LOOKING && laneNamed(lower) != null ->
          laneNamed(lower)?.let { walkLane(it) }
      // A choice on the display ("See memory" or "Not now", a memory lane's "Yes" or "Not now"):
      // anything that plainly means one of them picks it, not only the exact words.
      (phase == Phase.OFFER || phase == Phase.PERSON) && declines(lower) -> goHome()
      phase == Phase.PERSON && offeredLane != null && affirms(lower) -> acceptLane()
      (phase == Phase.OFFER || phase == Phase.PERSON) && offered != null && affirms(lower) -> acceptOffer()
      // "Memory lane" with nobody named: the memory that is open once more, or the list of memories.
      LANE_PHRASES.containsMatchIn(lower) && phase != Phase.LOOKING ->
          _ui.value.currentKeepsake?.takeIf { phase == Phase.MEMORY || phase == Phase.ANSWERING }
              ?.let { openKeepsake(it) } ?: browse("")
      // "Who's Maya?": someone in the family, asked about by name, says hello themselves.
      phase != Phase.LOOKING && phase != Phase.OFF && namedPerson(lower) != null ->
          namedPerson(lower)?.let { introduce(it) }
      // About the memory open on the display: "who's that?" is the person whose memory it is,
      // and "who's that girl?" whoever in it fits. Otherwise, a memory on offer included, the
      // camera looks: what is in view now may not be what was offered.
      WHO_PHRASES.containsMatchIn(lower) || whoDescription(lower) != null -> {
        val asked = whoDescription(lower).orEmpty()
        memoryWithPeople(phase)?.let { keepsake ->
          actionJob?.cancel()
          actionJob = viewModelScope.launch { answerWho(keepsake, asked) }
        } ?: run { if (phase != Phase.LOOKING) lookForPerson(asked) }
      }
      // "What's this?" always means look, even part-way through another memory: the wearer
      // has probably picked up something else.
      LOOK_PHRASES.containsMatchIn(lower) || phase == Phase.IDLE && MISHEARD_LOOK.containsMatchIn(lower) ->
          if (phase != Phase.LOOKING) look()
      phase == Phase.MEMORY || phase == Phase.ANSWERING ->
          when {
            // The lane, or the voice message, once more: "play it", "again", "watch it".
            asksAgain(lower) -> _ui.value.currentKeepsake?.let { openKeepsake(it) }
            lower.split(" ").size >= 2 -> ask(text)
          }
      // Anything else that sounds like a question is an everyday one: "Where is Margaret?"
      // It is answered if the family has recorded an answer, and passed to them if not.
      // About something in front of the wearer, with no memory open: look, then ask. A choice
      // still on the display ("See memory", "Done") is not taken to be what "this" means: the
      // wearer may have picked up something else. If it is the same thing, the look finds it.
      phase in setOf(Phase.IDLE, Phase.OFFER, Phase.PERSON) && looksLikeQuestion(lower) &&
          POINTS_AT.containsMatchIn(lower) -> lookThenAsk(text)
      phase != Phase.LOOKING && phase != Phase.OFF && looksLikeQuestion(lower) -> ask(text)
      else -> Unit
    }
  }

  // ---- Privacy pause and automatic looking -----------------------------------------------

  fun togglePrivacyPause() {
    val current = session
    if (current == null || _ui.value.link != Link.READY) return
    if (!_ui.value.paused) {
      actionJob?.cancel()
      // Not just ignored: the camera and the recogniser are actually switched off.
      cameraJob?.cancel()
      runCatching { camera?.stop() }
      runCatching { current.removeCamera() }
      camera = null
      detachSpeech(current)
      _ui.update { it.copy(paused = true, phase = Phase.PAUSED, cameraReady = false, listening = false) }
      show(
          messageScreen(
              "Paused",
              "Not looking or listening.",
              primary = "Carry on" to onMain { if (_ui.value.paused) togglePrivacyPause() },
          ),
      )
      repo.queueEvent("privacy_pause")
      log("Privacy pause: camera and listening are off")
    } else {
      _ui.update { it.copy(paused = false) }
      attachCamera(current)
      if (repo.listenForVoice) attachSpeech(current)
      repo.queueEvent("privacy_resume")
      log("Resumed")
      goHome()
    }
  }

  /**
   * For wearers who will not remember to ask. Costs a recognition call every 30 seconds
   * while the glasses are idle, so it is off unless the family turns it on.
   */
  fun setAutoLook(on: Boolean) {
    autoJob?.cancel()
    _ui.update { it.copy(autoLook = on) }
    if (!on) return
    autoJob =
        viewModelScope.launch {
          while (isActive) {
            delay(AUTO_LOOK_EVERY_MS)
            val state = _ui.value
            if (state.phase == Phase.IDLE && state.online && state.cameraReady) look(hint = null, quiet = true)
          }
        }
  }

  /**
   * Spoken questions and answers. The microphone is not opened unless the family turns this on;
   * every spoken action also has a button. The caller has asked for the microphone permission.
   */
  fun setListenForVoice(on: Boolean) {
    repo.listenForVoice = on
    _ui.update { it.copy(listenForVoice = on) }
    val live = on && granted(Manifest.permission.RECORD_AUDIO)
    runCatching {
      mockGlasses?.services?.speech?.setTranscriptionSource(
          if (live) MockSpeechSource.LIVE_DEVICE_ASR else MockSpeechSource.INJECTED,
      )
    }
    val current = session ?: return
    if (_ui.value.link != Link.READY || _ui.value.paused) return
    if (on && speech == null) attachSpeech(current) else if (!on) detachSpeech(current)
    log(if (on) "Spoken questions on: the capture button is push to talk" else "Microphone off")
    if (_ui.value.phase == Phase.IDLE) goHome()
  }

  // ---- Simulated glasses only ------------------------------------------------------------

  fun simulateWorn(worn: Boolean) {
    mockGlasses?.let { if (worn) it.don() else it.doff() }
  }

  /**
   * Sets the heart rate the simulated glasses' motion carries, or [bpm] null for automatic (a
   * resting rate that rises with most memories). The pulse is still read from that motion, so a
   * change shows on the phone, and in what the family sees, about fifteen seconds later.
   */
  fun simulateHeart(bpm: Int?) {
    val set = bpm?.coerceIn(SIM_BPM_RANGE)
    _ui.update { it.copy(heartSetBpm = set) }
    madeUpHeart.fixedBpm = set
    log(if (set == null) "Simulated heart rate: automatic" else "Simulated heart rate set to $set")
    if (_ui.value.heartOn) replayMockMotion(mockMemoryOpen)
  }

  fun simulateBattery(level: Int) {
    mockGlasses?.setBatteryLevel(level)
  }

  /** The phone's Talk button: on simulated glasses it presses their capture button, so both go the same way. */
  fun pressTalk() {
    val glasses = mockGlasses
    if (glasses != null) glasses.services.input.capture(CapturePressType.SHORT_PRESS) else pushToTalk()
  }

  /** Something the wearer says, on simulated glasses: the capture button is pressed first, as they would. */
  fun simulateSpeech(text: String) {
    val glasses = mockGlasses
    if (text.isBlank() || glasses == null) return
    viewModelScope.launch {
      if (talkJob?.isActive != true) glasses.services.input.capture(CapturePressType.SHORT_PRESS)
      val open = withTimeoutOrNull(5_000) { _ui.first { it.listening } } != null
      if (!open) log("Said “${text.trim()}”, but the microphone did not open")
      glasses.services.speech.simulateTranscription(text.trim(), true, 0.9f)
    }
  }

  /**
   * Debug builds only: makes looks "see" a fixed picture instead of the camera, so the whole loop
   * can be tested the same way every time. The test (android/e2e/run.mjs) pushes the pictures
   * into the app's files/test-camera/ folder; none are built in. The glasses camera is still
   * asked for a photo on each look; its picture is swapped for this one before it is sent.
   * (The Mock Device Kit's own fixed-image option is ignored while the phone camera is the
   * feed, which is why the swap happens here.) Pass a blank name to go back to the camera.
   */
  fun useTestFrame(assetName: String) {
    if (assetName.isBlank()) {
      testFrame = null
      log("Test frame cleared")
      return
    }
    viewModelScope.launch {
      testFrame =
          withContext(Dispatchers.IO) {
            runCatching {
                  val folder = File(getApplication<Application>().getExternalFilesDir(null), "test-camera")
                  Base64.encodeToString(File(folder, File(assetName).name).readBytes(), Base64.NO_WRAP)
                }
                .getOrNull()
          }
      log(if (testFrame == null) "Test frame not found: $assetName" else "Test frame set: $assetName")
    }
  }

  fun toggleChromePreview() {
    val kit = MockDeviceKit.getInstance(getApplication())
    if (_ui.value.chromePreview != null) {
      kit.stopTestServer()
      _ui.update { it.copy(chromePreview = null) }
      return
    }
    kit.startTestServer(9000)
        .fold(
            onSuccess = { port ->
              _ui.update {
                it.copy(
                    chromePreview =
                        "On the laptop:\n  adb forward tcp:$port tcp:$port\n" +
                            "Then open http://127.0.0.1:$port/ in Chrome with the\n" +
                            "Meta Ray-Ban Display Simulator extension.",
                )
              }
            },
            onFailure = { error, _ -> notice("Chrome preview would not start: $error") },
        )
  }

  // ---- Housekeeping ----------------------------------------------------------------------

  private fun notice(text: String) {
    _ui.update { it.copy(notice = text) }
    log(text)
  }

  private fun log(text: String) {
    Log.i(TAG, text)
    val line = "${LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm:ss"))}  $text"
    _ui.update { it.copy(log = (it.log + line).takeLast(60)) }
  }

  override fun onCleared() {
    disconnect()
    narrator.shutdown()
  }
}
