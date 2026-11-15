package com.memorylane.glasses

import android.Manifest
import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BlendMode
import android.graphics.Paint
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Battery1Bar
import androidx.compose.material.icons.outlined.Battery2Bar
import androidx.compose.material.icons.outlined.Battery3Bar
import androidx.compose.material.icons.outlined.Battery4Bar
import androidx.compose.material.icons.outlined.Battery5Bar
import androidx.compose.material.icons.outlined.Battery6Bar
import androidx.compose.material.icons.outlined.BatteryAlert
import androidx.compose.material.icons.outlined.BatteryFull
import androidx.compose.material.icons.outlined.Bluetooth
import androidx.compose.material.icons.outlined.BluetoothConnected
import androidx.compose.material.icons.outlined.BluetoothDisabled
import androidx.compose.material.icons.outlined.BluetoothSearching
import androidx.compose.material.icons.outlined.CenterFocusStrong
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Fullscreen
import androidx.compose.material.icons.outlined.Hearing
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Thermostat
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Shapes
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.meta.wearable.dat.mockdevice.api.display.MockDisplayKit
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission

/**
 * Holds the glasses session for as long as the app process lives, so closing the screen, or
 * swiping the app away while the background service is running, does not cut the wearer off.
 */
class MemoryLaneApp : Application(), ViewModelStoreOwner {
  override val viewModelStore = ViewModelStore()
}

class MainActivity : ComponentActivity() {
  private val vm: GlassesViewModel by lazy {
    val app = application as MemoryLaneApp
    ViewModelProvider(app, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[GlassesViewModel::class.java]
  }

  private var wearablesStarted = false
  private var askedBluetooth = false
  private var launchIntentSpent = false

  /** Messages that come from the activity itself (permissions, registration), not the glasses. */
  private var activityNotice by mutableStateOf<String?>(null)

  /** Shows nothing but the simulated lens, full screen: for demos, recordings and tests. */
  private var lensOnly by mutableStateOf(false)

  /** The settings page is open over the home screen. */
  private var settingsOpen by mutableStateOf(false)

  private val bluetoothLauncher =
      registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { startWearables() }

  private val simulatedLauncher =
      registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        if (results.values.any { !it }) {
          activityNotice =
              "Camera or microphone access was refused, so the simulated glasses cannot see or hear. " +
                  "Memories can still be played from Settings."
        }
        vm.connect(simulated = true)
      }

  // The Meta AI app asks the wearer for each of these in turn. The microphone only when the
  // family has turned on listening.
  private val microphoneLauncher =
      registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        result.onFailure { error, _ -> activityNotice = "Microphone: ${error.description}" }
        vm.connect(simulated = false)
      }

  private val cameraLauncher =
      registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        result.onFailure { error, _ -> activityNotice = "Camera: ${error.description}" }
        if (vm.ui.value.listenForVoice) microphoneLauncher.launch(Permission.MICROPHONE) else vm.connect(simulated = false)
      }

  // Turning listening on while connected: ask for the microphone first, and stay off if refused.
  private val glassesListenLauncher =
      registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        var allowed = true
        result.onFailure { error, _ ->
          allowed = false
          activityNotice = "Microphone: ${error.description}"
        }
        if (allowed) vm.setListenForVoice(true)
      }

  private val phoneListenLauncher =
      registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) vm.setListenForVoice(true)
        else activityNotice = "Microphone access was refused, so spoken questions stay off."
      }

  private fun setListening(on: Boolean) {
    when {
      !on || vm.ui.value.source == Source.NONE -> vm.setListenForVoice(on)
      vm.ui.value.source == Source.SIMULATED -> phoneListenLauncher.launch(Manifest.permission.RECORD_AUDIO)
      else -> glassesListenLauncher.launch(Permission.MICROPHONE)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The bar at the top of every page is dark, and runs up under the status bar.
    enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
    askedBluetooth = savedInstanceState?.getBoolean("askedBluetooth") ?: false
    // Reopened from Recents, or rebuilt after the system ended the app: the intent is the one it
    // was first launched with, already acted on. Acting on it again would replay test commands.
    launchIntentSpent =
        savedInstanceState != null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
    setContent {
      MemoryLaneTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          val lens by vm.mockDisplay.collectAsStateWithLifecycle()
          val kit = lens
          if (settingsOpen) {
            androidx.activity.compose.BackHandler { settingsOpen = false }
            SettingsScreen(vm = vm, onBack = { settingsOpen = false }, onListen = ::setListening)
          } else if (lensOnly && kit != null) {
            androidx.activity.compose.BackHandler { lensOnly = false }
            Box(modifier = Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
              Lens(vm, kit, Modifier.fillMaxWidth().aspectRatio(1f))
            }
          } else {
            // While the glasses are connected, Back must not close the app: that would end
            // the wearer's session. It goes to the background and keeps running.
            val connected by vm.ui.collectAsStateWithLifecycle()
            androidx.activity.compose.BackHandler(enabled = connected.source != Source.NONE) {
              moveTaskToBack(true)
            }
          HomeScreen(
              vm = vm,
              onLensOnly = { lensOnly = true },
              onSettings = { settingsOpen = true },
              activityNotice = activityNotice,
              onUseSimulated = {
                activityNotice = null
                val wanted = listOfNotNull(
                    Manifest.permission.CAMERA,
                    Manifest.permission.RECORD_AUDIO.takeIf { vm.ui.value.listenForVoice },
                )
                simulatedLauncher.launch(wanted.toTypedArray())
              },
              onConnectReal = { registered ->
                if (!registered) {
                  activityNotice = "Finish pairing in the Meta AI app, then tap Connect glasses again."
                  Wearables.startRegistration(this)
                } else {
                  activityNotice = null
                  cameraLauncher.launch(Permission.CAMERA)
                }
              },
          )
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
  }

  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    // The QR code in the family app opens memorylane://pair?server=...&code=...
    val link = intent.data
    if (link != null && link.scheme == "memorylane" && link.host == "pair") {
      val server = link.getQueryParameter("server").orEmpty()
      if (server.startsWith("http://") || server.startsWith("https://")) {
        vm.pair(server, link.getQueryParameter("code").orEmpty())
        activityNotice = "Paired with the family app at $server."
      } else {
        activityNotice = "The pairing code could not be read. Scan it again."
      }
      return
    }
    // Debug builds can be driven from a laptop for automated tests, for example:
    //   adb shell am start -n com.memorylane.glasses/.MainActivity --es action look
    if (!BuildConfig.DEBUG) return
    intent.getStringExtra("test_frame")?.let { vm.useTestFrame(it) }
    intent.getStringExtra("say")?.let { vm.simulateSpeech(it) }
    when (intent.getStringExtra("action")) {
      "simulated" -> vm.connect(simulated = true)
      "look" -> vm.look()
      "who" -> vm.lookForPerson()
      "see" -> vm.acceptOffer()
      "lane_yes" -> vm.acceptLane()
      "home" -> vm.goHome()
      "pause" -> vm.togglePrivacyPause()
      "auto_on" -> vm.setAutoLook(true)
      "auto_off" -> vm.setAutoLook(false)
      "listen_on" -> setListening(true)
      "listen_off" -> setListening(false)
      "talk" -> vm.pressTalk()
      "doff" -> vm.simulateWorn(false)
      "don" -> vm.simulateWorn(true)
      "battery_low" -> vm.simulateBattery(10)
      "sync" -> vm.syncNow()
      "preview" -> vm.toggleChromePreview()
      "lens" -> lensOnly = true
      "lens_off" -> lensOnly = false
      "settings" -> settingsOpen = true
      "settings_off" -> settingsOpen = false
      "disconnect" -> vm.disconnect()
    }
    intent.getStringExtra("open")?.let { vm.openKeepsake(it) }
    intent.getStringExtra("lane")?.let { vm.openLane(it) }
  }

  override fun onStart() {
    super.onStart()
    if (wearablesStarted) return
    if (!askedBluetooth) {
      askedBluetooth = true
      // Notifications carry the "connected to the glasses" notice that keeps the session
      // alive in a pocket.
      bluetoothLauncher.launch(
          if (Build.VERSION.SDK_INT >= 33) {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.POST_NOTIFICATIONS)
          } else {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT)
          },
      )
    } else {
      startWearables()
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putBoolean("askedBluetooth", askedBluetooth)
  }

  private fun startWearables() {
    if (wearablesStarted) return
    wearablesStarted = true
    Wearables.initialize(this).onFailure { error, _ ->
      // The toolkit can bring itself up before we ask. That is not a failure.
      if (!error.description.contains("already", ignoreCase = true)) {
        activityNotice = "Could not start the glasses toolkit: ${error.description}"
      }
    }
    vm.onWearablesReady()
    if (!launchIntentSpent) handleIntent(intent)
  }
}

// Calm and light, in the colours of the mark: deep teal words on a pale ground, with white cards.
private val Deep = Color(0xFF0E343F)
private val Teal = Color(0xFF15586A)
private val Ground = Color(0xFFF1F6F7)
private val CardColor = Color(0xFFFFFFFF)
private val LightColors =
    lightColorScheme(
        primary = Teal,
        onPrimary = Color(0xFFFFFFFF),
        primaryContainer = Color(0xFFE1F0F3),
        onPrimaryContainer = Deep,
        secondary = Teal,
        onSecondary = Color(0xFFFFFFFF),
        background = Ground,
        onBackground = Deep,
        surface = Ground,
        onSurface = Deep,
        surfaceVariant = Color(0xFFE1F0F3),
        onSurfaceVariant = Color(0xFF4F6B73),
        outline = Color(0xFFB5CDD3),
        outlineVariant = Color(0xFFD7E5E8),
        error = Color(0xFFB3261E),
        onError = Color(0xFFFFFFFF),
    )

/** The soft colours a memory's tile takes, in turn. They mean nothing: they only tell tiles apart. */
private val TileColors =
    listOf(Color(0xFF45C3CF), Color(0xFFE8B36A), Color(0xFF15586A), Color(0xFF8FCB9B), Color(0xFFEC8E9A), Color(0xFF8C9FDD))

/** Lexend, the family app's typeface: one file that holds every weight. */
@OptIn(ExperimentalTextApi::class)
private val Lexend =
    FontFamily(
        listOf(300, 400, 500, 600, 700).map { weight ->
          Font(R.font.lexend, weight = FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
        },
    )

private val AppTypography =
    Typography().let { t ->
      Typography(
          displayLarge = t.displayLarge.copy(fontFamily = Lexend),
          displayMedium = t.displayMedium.copy(fontFamily = Lexend),
          displaySmall = t.displaySmall.copy(fontFamily = Lexend),
          headlineLarge = t.headlineLarge.copy(fontFamily = Lexend),
          headlineMedium = t.headlineMedium.copy(fontFamily = Lexend),
          headlineSmall = t.headlineSmall.copy(fontFamily = Lexend),
          titleLarge = t.titleLarge.copy(fontFamily = Lexend),
          titleMedium = t.titleMedium.copy(fontFamily = Lexend),
          titleSmall = t.titleSmall.copy(fontFamily = Lexend),
          bodyLarge = t.bodyLarge.copy(fontFamily = Lexend),
          bodyMedium = t.bodyMedium.copy(fontFamily = Lexend),
          bodySmall = t.bodySmall.copy(fontFamily = Lexend),
          labelLarge = t.labelLarge.copy(fontFamily = Lexend),
          labelMedium = t.labelMedium.copy(fontFamily = Lexend),
          labelSmall = t.labelSmall.copy(fontFamily = Lexend),
      )
    }

/** Everything is rounded, and nothing has a hard corner. */
private val AppShapes =
    Shapes(
        extraSmall = RoundedCornerShape(10.dp),
        small = RoundedCornerShape(14.dp),
        medium = RoundedCornerShape(18.dp),
        large = RoundedCornerShape(24.dp),
        extraLarge = RoundedCornerShape(28.dp),
    )

/** The bar across the top: the night the mark sits on. Words and icons on it are white. */
private val BarColor = Color(0xFF0E343F)
private val BarColors =
    darkColorScheme(
        surface = BarColor,
        onSurface = Color(0xFFFFFFFF),
        onSurfaceVariant = Color(0xFFB9CDD2),
        error = Color(0xFFFFB4AB),
    )
/** The room a page under the bar keeps clear: the edges and the bottom. The bar keeps the top. */
private val belowBar
  @Composable get() = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)

@Composable
private fun MemoryLaneTheme(content: @Composable () -> Unit) {
  MaterialTheme(colorScheme = LightColors, typography = AppTypography, shapes = AppShapes, content = content)
}

/** What is happening right now, in a few words. */
private fun headline(state: UiState): String {
  val name = state.keepsakes.firstOrNull { it.id == state.currentKeepsake }?.name
  if (state.source == Source.NONE) return "Not connected"
  return when (state.link) {
    Link.CONNECTING -> "Connecting…"
    Link.LOST -> "Reconnecting…"
    Link.OFF -> "Not connected"
    Link.READY ->
        when (state.phase) {
          Phase.OFF -> "Starting…"
          Phase.NEEDS_CONSENT -> "Waiting for consent"
          Phase.IDLE -> "Ready"
          Phase.LOOKING -> "Looking…"
          Phase.OFFER -> if (name != null) "Memory found: $name" else "Memory found"
          Phase.PERSON -> "Person recognised"
          Phase.MEMORY -> if (name != null) "Playing: $name" else "Playing a memory"
          Phase.ANSWERING -> "Answering a question"
          Phase.UNKNOWN -> "No memory for this object"
          Phase.BROWSE -> "Browsing memories"
          Phase.FILM -> if (name != null) "Memory lane: $name" else "Playing a memory lane"
          Phase.PERSON_LANE -> "Walking memory lane"
          Phase.PAUSED -> "Paused"
          Phase.REMOVED -> "Glasses taken off"
        }
  }
}

/** The step still to do before the glasses are worth connecting, if any. */
private fun setupStep(state: UiState): String? =
    when {
      !state.online -> "Pair with the family app: open Settings there and scan its code with this phone."
      !state.consentGiven -> "Record ${state.wearerName.ifBlank { "the wearer" }}'s consent in the family app, under Settings."
      state.keepsakes.isEmpty() -> "Add a first memory in the family app."
      else -> null
    }

/**
 * The SDK asks for player controls on every clip (DisplaySessionImpl passes showControls = true,
 * and VideoPlayer has no way to say otherwise). The simulated lens is a web page, so its <video>
 * then draws the browser's play button and loading spinner over the clip while it buffers, and
 * WebView's grey default poster before that. This takes both away: a clip that is not ready yet
 * leaves the lens clear, as a blank display is.
 */
private const val HIDE_VIDEO_CONTROLS =
    """(()=>{if(window.__quietVideo)return;window.__quietVideo=1;
const s=document.createElement('style');s.textContent='video::-webkit-media-controls{display:none!important}';
document.head.appendChild(s);
const strip=()=>document.querySelectorAll('video[controls]').forEach(v=>v.removeAttribute('controls'));
strip();new MutationObserver(strip).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['controls']});})()"""

private fun quietVideo(view: View) {
  val web = view as? WebView ?: return
  // The kit's own client serves the page and carries its bridge: everything it handles is passed on.
  val inner = web.webViewClient
  web.webViewClient =
      object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
            inner.shouldInterceptRequest(view, request)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
            inner.shouldOverrideUrlLoading(view, request)

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) = inner.onPageStarted(view, url, favicon)

        override fun onPageFinished(view: WebView, url: String?) {
          inner.onPageFinished(view, url)
          view.evaluateJavascript(HIDE_VIDEO_CONTROLS, null)
        }
      }
  web.webChromeClient =
      object : WebChromeClient() {
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
      }
}

/**
 * The lens as the wearer sees it: what the app draws, over what the camera sees (simulated
 * glasses only; without a camera view the lens is shown on black, which is clear glass).
 */
@Composable
private fun Lens(vm: GlassesViewModel, kit: MockDisplayKit, modifier: Modifier) {
  // Clipped: the camera picture is cropped to fill the lens, and would otherwise spill past it.
  Box(modifier = modifier.clipToBounds().background(Color.Black)) {
    if (vm.ui.collectAsStateWithLifecycle().value.source == Source.SIMULATED) {
      CameraUnderlay(vm.cameraFeed, Modifier.fillMaxSize())
    }
    key(kit) {
      AndroidView(
          factory = { context ->
            kit.createPreviewView(context).apply {
              quietVideo(this)
              // The lens adds light to what is behind it, as the real display does: its black is
              // clear glass. Without a camera view this is the same as drawing it on black.
              setLayerType(View.LAYER_TYPE_HARDWARE, Paint().apply { blendMode = BlendMode.SCREEN })
            }
          },
          modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

/**
 * The home screen, laid out like any app for a connected device: the device and its state in
 * the bar at the top, the device itself (the simulated lens, or a card for real glasses) as the
 * main view, its controls under it, and everything else in Settings.
 */
@Composable
private fun HomeScreen(
    vm: GlassesViewModel,
    activityNotice: String?,
    onLensOnly: () -> Unit,
    onSettings: () -> Unit,
    onUseSimulated: () -> Unit,
    onConnectReal: (registered: Boolean) -> Unit,
) {
  val state by vm.ui.collectAsStateWithLifecycle()
  val mockDisplay by vm.mockDisplay.collectAsStateWithLifecycle()
  val connected = state.source != Source.NONE

  Column(modifier = Modifier.fillMaxSize()) {
    TopBar(
        title = "MemoryLane",
        mark = true,
        leading = { DeviceStatus(state) },
        subtitle =
            when (state.source) {
              Source.NONE -> "No glasses"
              Source.SIMULATED -> "Simulated glasses"
              Source.REAL -> state.deviceName.ifBlank { "Glasses" }
            },
    ) {
      IconButton(onClick = onSettings) { Icon(Icons.Outlined.Settings, contentDescription = "Settings") }
    }

    Column(
        modifier =
            Modifier.fillMaxSize().windowInsetsPadding(belowBar).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      val heroModifier = Modifier.padding(top = 16.dp).fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(28.dp))
      val kit = mockDisplay
      if (kit != null) {
        Box(modifier = heroModifier) {
          Lens(vm, kit, Modifier.fillMaxSize())
          IconButton(
              onClick = onLensOnly,
              modifier =
                  Modifier.align(Alignment.TopEnd).padding(8.dp).background(Color.Black.copy(alpha = 0.45f), CircleShape),
          ) {
            Icon(Icons.Outlined.Fullscreen, contentDescription = "Full screen", tint = Color.White)
          }
        }
      } else {
        DeviceCard(state, heroModifier.background(CardColor))
      }

      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(headline(state), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        (activityNotice ?: state.notice ?: if (!connected) setupStep(state) else null)?.let {
          Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
      }

      if (connected) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.Top,
        ) {
          // Push to talk, as the capture button on the glasses is. On simulated glasses it presses theirs.
          if (state.listenForVoice) {
            Control(
                icon = if (state.listening) Icons.Outlined.MicOff else Icons.Outlined.Mic,
                label = if (state.listening) "Stop" else "Talk",
            ) {
              vm.pressTalk()
            }
          }
          Control(icon = Icons.Outlined.CenterFocusStrong, label = "Look", primary = true) { vm.look() }
          Control(
              icon = if (state.paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
              label = if (state.paused) "Resume" else "Pause",
          ) {
            vm.togglePrivacyPause()
          }
        }
      } else {
        Button(onClick = { onConnectReal(state.registered) }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
          Icon(Icons.Outlined.Bluetooth, contentDescription = null)
          Spacer(Modifier.width(8.dp))
          Text("Connect glasses", style = MaterialTheme.typography.titleMedium)
        }
        TextButton(onClick = onUseSimulated, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
          Text("Use simulated glasses", style = MaterialTheme.typography.titleMedium)
        }
      }

      // A memory's lane or a person's memory lane playing on the glasses.
      if (state.phase == Phase.FILM || state.phase == Phase.PERSON_LANE) {
        OutlinedButton(onClick = { vm.goHome() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
          Text("Stop the memory lane")
        }
      }

      // Memories with photos or a video made into a lane: played on the glasses like any memory,
      // so on simulated glasses they fill the lens and nothing more.
      val films = state.keepsakes.filter { it.hasLane }
      if (films.isNotEmpty()) {
        Section("Memory lanes") {
          films.forEachIndexed { index, keepsake ->
            ItemRow(
                title = keepsake.name,
                tile = index,
                detail = if (connected) "Play on the glasses" else "Connect glasses to play",
                leading = Icons.Outlined.Movie,
                onClick = if (connected) ({ vm.openKeepsake(keepsake.id) }) else null,
            )
          }
        }
      }
      Spacer(Modifier.height(8.dp))
    }
  }
}

/**
 * The bar at the top of a page: dark, with the title in white at its centre (on the home page,
 * the mark and the name), Back or the glasses' state at the start, and icons at the end.
 */
@Composable
private fun TopBar(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    mark: Boolean = false,
    leading: @Composable () -> Unit = {},
    actions: @Composable () -> Unit = {},
) {
  // A dark set of colours inside the bar, so icons that take theirs from the theme stay readable.
  MaterialTheme(colorScheme = BarColors, typography = MaterialTheme.typography) {
    CompositionLocalProvider(LocalContentColor provides Color.White) {
      // The title sits at the centre while there is room for it there. When the ends are wide, as
      // with the glasses' state on a narrow phone, it moves aside and shortens, so nothing overlaps.
      androidx.compose.ui.layout.Layout(
          modifier =
              Modifier.fillMaxWidth()
                  .background(BarColor)
                  .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Top))
                  .heightIn(min = 64.dp)
                  .padding(horizontal = 4.dp),
          content = {
            Row(
                modifier = Modifier.padding(start = if (onBack == null) 12.dp else 0.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
              onBack?.let {
                IconButton(onClick = it) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
              }
              leading()
            }
            Row(verticalAlignment = Alignment.CenterVertically) { actions() }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
              Row(verticalAlignment = Alignment.CenterVertically) {
                if (mark) {
                  androidx.compose.foundation.Image(
                      painter = androidx.compose.ui.res.painterResource(R.drawable.ic_mark_white),
                      contentDescription = null,
                      modifier = Modifier.padding(end = 8.dp).size(26.dp),
                  )
                }
                Text(
                    title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
              }
              subtitle?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
              }
            }
          },
      ) { measurables, constraints ->
        val width = constraints.maxWidth
        val gap = 8.dp.roundToPx()
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val start = measurables[0].measure(loose)
        val end = measurables[1].measure(loose.copy(maxWidth = (width - start.width).coerceAtLeast(0)))
        val room = (width - start.width - end.width - 2 * gap).coerceAtLeast(0)
        val center = measurables[2].measure(loose.copy(maxWidth = room))
        val height = maxOf(constraints.minHeight, start.height, end.height, center.height)
        layout(width, height) {
          start.place(0, (height - start.height) / 2)
          end.place(width - end.width, (height - end.height) / 2)
          val centred = (width - center.width) / 2
          val x = maxOf(start.width + gap, minOf(centred, width - end.width - gap - center.width))
          center.place(x, (height - center.height) / 2)
        }
      }
    }
  }
}

/** The glasses' state as icons: link, battery and anything wrong, each named for screen readers. */
@Composable
private fun DeviceStatus(state: UiState) {
  val muted = MaterialTheme.colorScheme.onSurfaceVariant
  Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    if (!state.online) Icon(Icons.Outlined.CloudOff, contentDescription = "Family app not reachable", tint = muted)
    if (state.hot) {
      Icon(Icons.Outlined.Thermostat, contentDescription = "Glasses running warm", tint = MaterialTheme.colorScheme.error)
    }
    val (link, linkLabel) =
        when {
          state.source == Source.NONE || state.link == Link.OFF -> Icons.Outlined.BluetoothDisabled to "Glasses not connected"
          state.link == Link.READY -> Icons.Outlined.BluetoothConnected to "Glasses connected"
          else -> Icons.Outlined.BluetoothSearching to "Connecting to the glasses"
        }
    Icon(link, contentDescription = linkLabel, tint = if (state.link == Link.READY) MaterialTheme.colorScheme.onSurface else muted)
    state.battery?.takeIf { state.source != Source.NONE }?.let { level ->
      val low = level <= LOW_BATTERY
      val bars =
          listOf(
              Icons.Outlined.Battery1Bar,
              Icons.Outlined.Battery2Bar,
              Icons.Outlined.Battery3Bar,
              Icons.Outlined.Battery4Bar,
              Icons.Outlined.Battery5Bar,
              Icons.Outlined.Battery6Bar,
          )
      val icon =
          when {
            low -> Icons.Outlined.BatteryAlert
            level >= 95 -> Icons.Outlined.BatteryFull
            else -> bars[((level - LOW_BATTERY) * bars.size / (95 - LOW_BATTERY)).coerceIn(0, bars.size - 1)]
          }
      val tint = if (low) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
      Row(
          modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "Battery $level percent" },
          verticalAlignment = Alignment.CenterVertically,
      ) {
        // The battery icons stand upright; a device bar shows them lying down.
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.rotate(90f))
        Text("$level%", style = MaterialTheme.typography.labelLarge, color = tint)
      }
    }
  }
}

/**
 * The main view when there is no lens to show, as with real glasses, which draw it on the
 * glasses alone: an icon for what they are doing, and a line on how the wearer is shown things.
 */
@Composable
private fun DeviceCard(state: UiState, modifier: Modifier) {
  val ready = state.source != Source.NONE && state.link == Link.READY
  val icon =
      when {
        state.source == Source.NONE -> Icons.Outlined.BluetoothDisabled
        !ready -> Icons.Outlined.BluetoothSearching
        state.phase == Phase.PAUSED -> Icons.Outlined.Pause
        state.phase == Phase.REMOVED -> Icons.Outlined.VisibilityOff
        state.phase == Phase.LOOKING -> Icons.Outlined.CenterFocusStrong
        state.phase in setOf(Phase.MEMORY, Phase.FILM, Phase.PERSON_LANE) -> Icons.Outlined.Movie
        state.phase == Phase.ANSWERING -> Icons.Outlined.Hearing
        else -> Icons.Outlined.Visibility
      }
  val caption =
      when {
        state.source == Source.NONE -> "Connect a pair of Meta glasses, or try the app with simulated glasses."
        !ready -> "Keep the glasses close to this phone."
        state.hasDisplay -> "The display is shown on the glasses only."
        else -> "These glasses have no display. Everything is spoken."
      }
  Column(
      modifier = modifier.padding(24.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
      horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    // The icon sits in a pale round, like a small drawing, not a warning.
    Box(
        modifier = Modifier.size(132.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
      Icon(icon, contentDescription = null, modifier = Modifier.size(60.dp), tint = MaterialTheme.colorScheme.primary)
    }
    Text(
        caption,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
  }
}

/** One of the controls under the main view: a round button with its name under it. */
@Composable
private fun Control(icon: ImageVector, label: String, primary: Boolean = false, onClick: () -> Unit) {
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
    // Every button sits in a box of the largest size, so the labels line up.
    Box(modifier = Modifier.size(72.dp), contentAlignment = Alignment.Center) {
      if (primary) {
        FilledIconButton(onClick = onClick, modifier = Modifier.size(72.dp)) {
          Icon(icon, contentDescription = label, modifier = Modifier.size(32.dp))
        }
      } else {
        OutlinedIconButton(onClick = onClick, modifier = Modifier.size(60.dp)) {
          Icon(icon, contentDescription = label, modifier = Modifier.size(26.dp))
        }
      }
    }
    Text(label, style = MaterialTheme.typography.labelLarge)
  }
}

/** Everything not needed while the glasses are in use: options, memories, testing, the log. */
@Composable
private fun SettingsScreen(vm: GlassesViewModel, onBack: () -> Unit, onListen: (Boolean) -> Unit) {
  val state by vm.ui.collectAsStateWithLifecycle()
  val connected = state.source != Source.NONE
  val muted = MaterialTheme.colorScheme.onSurfaceVariant

  Column(modifier = Modifier.fillMaxSize()) {
    TopBar(title = "Settings", onBack = onBack)
    Column(
        modifier =
            Modifier.fillMaxSize().windowInsetsPadding(belowBar).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Section("Glasses") {
        SwitchRow(
            "Spoken questions",
            "Press the capture button on the glasses, then speak. Uses the microphone.",
            state.listenForVoice,
            onListen,
        )
        if (connected) {
          SwitchRow("Look automatically", "Looks at regular intervals without a button press.", state.autoLook) {
            vm.setAutoLook(it)
          }
          OutlinedButton(onClick = { vm.disconnect() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("Disconnect")
          }
        }
      }

      Section("Memories on this phone") {
        if (state.keepsakes.isEmpty()) Text("None yet.", style = MaterialTheme.typography.bodyMedium, color = muted)
        state.keepsakes.forEach { keepsake ->
          ItemRow(title = keepsake.name) {
            if (connected && state.recogniser == "rehearsal") {
              TextButton(onClick = { vm.look(hint = keepsake.id) }) { Text("Pretend in view") }
            }
            if (connected) {
              IconButton(onClick = { vm.openKeepsake(keepsake.id) }) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = "Play “${keepsake.name}” on the glasses")
              }
            }
          }
        }
        if (state.recogniser == "rehearsal") {
          Text(
              "Rehearsal mode: the server has no vision model, so objects are chosen here instead of recognised.",
              style = MaterialTheme.typography.bodySmall,
              color = muted,
          )
        }
      }

      if (state.heartOn) {
        Section("Heart rate") {
          val reading =
              when {
                !connected -> "Read while the glasses are connected."
                state.heartBpm == null -> "Waiting for a steady reading. Keep the head still."
                state.heartSource == HEART_SIMULATED -> "${state.heartBpm} bpm (simulated)"
                else -> "${state.heartBpm} bpm"
              }
          Text(reading, style = MaterialTheme.typography.bodyLarge)
          Text(
              "Read from the glasses' motion sensors and noted only while a memory is open. " +
                  "Turned on and off in the family app, under Privacy.",
              style = MaterialTheme.typography.bodySmall,
              color = muted,
          )
        }
      }

      if (state.source == Source.SIMULATED) {
        Section("Simulation") {
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SmallButton("Take off", Modifier.weight(1f)) { vm.simulateWorn(false) }
            SmallButton("Put on", Modifier.weight(1f)) { vm.simulateWorn(true) }
            SmallButton("Low battery", Modifier.weight(1f)) { vm.simulateBattery(10) }
          }
          if (state.heartOn) {
            val set = state.heartSetBpm
            Text(
                if (set != null) "Heart rate held at $set bpm." else "Heart rate automatic: it rises with most memories.",
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              val from = set ?: state.heartBpm ?: 70
              SmallButton("−5", Modifier.weight(1f)) { vm.simulateHeart(from - 5) }
              SmallButton("+5", Modifier.weight(1f)) { vm.simulateHeart(from + 5) }
              SmallButton("Auto", Modifier.weight(1f)) { vm.simulateHeart(null) }
            }
            Text(
                "A change shows about 15 seconds later: the pulse is still read from the motion.",
                style = MaterialTheme.typography.bodySmall,
                color = muted,
            )
          }
          var spoken by remember { mutableStateOf("") }
          OutlinedTextField(
              value = spoken,
              onValueChange = { spoken = it },
              label = { Text("Something the wearer says") },
              singleLine = true,
              trailingIcon = {
                IconButton(
                    onClick = {
                      if (spoken.isNotBlank()) {
                        vm.simulateSpeech(spoken.trim())
                        spoken = ""
                      }
                    },
                ) {
                  Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = "Say it")
                }
              },
              modifier = Modifier.fillMaxWidth(),
          )
          SwitchRow(
              "Chrome display preview",
              "Mirrors the lens to the Meta display simulator extension.",
              state.chromePreview != null,
          ) {
            vm.toggleChromePreview()
          }
          state.chromePreview?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
          }
        }
      }

      Section("Family app") {
        var address by remember(state.serverUrl) { mutableStateOf(state.serverUrl) }
        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("Address") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          SmallButton("Save", Modifier.weight(1f)) { vm.setServerUrl(address) }
          SmallButton("Sync now", Modifier.weight(1f)) { vm.syncNow() }
        }
        Text(
            (if (state.online) "Connected" else "Not reachable") + (state.lastLookMs?.let { " · last look $it ms" } ?: ""),
            style = MaterialTheme.typography.bodySmall,
            color = muted,
        )
      }

      Section("Activity") {
        if (state.heard.isNotBlank()) Text("Last heard: ${state.heard}", style = MaterialTheme.typography.bodyMedium)
        Text(
            if (state.log.isEmpty()) "Nothing yet." else state.log.takeLast(40).joinToString("\n"),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = muted,
        )
      }
    }
  }
}

/** A small heading over a group of rows, which sit together on a white card. */
@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
  Column(modifier = Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(
        title,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Column(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(CardColor).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      content()
    }
  }
}

/** A row in a list, flush with the page's margins: an optional icon, a name, and actions at the end. */
@Composable
private fun ItemRow(
    title: String,
    detail: String? = null,
    leading: ImageVector? = null,
    /** Where the row comes in its list, so neighbouring tiles take different colours. */
    tile: Int? = null,
    onClick: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
) {
  Row(
      modifier =
          Modifier.fillMaxWidth()
              .heightIn(min = 56.dp)
              .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
              .padding(vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    // A soft tile of colour with the icon in white. The colour only tells one row from the next.
    leading?.let {
      Box(
          modifier =
              Modifier.size(46.dp).background(TileColors[Math.floorMod(tile ?: title.hashCode(), TileColors.size)], RoundedCornerShape(15.dp)),
          contentAlignment = Alignment.Center,
      ) {
        Icon(it, contentDescription = null, tint = Color.White, modifier = Modifier.size(24.dp))
      }
    }
    Column(modifier = Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      detail?.let {
        Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
    actions()
  }
}

@Composable
private fun SmallButton(label: String, modifier: Modifier = Modifier.fillMaxWidth(), onClick: () -> Unit) {
  OutlinedButton(onClick = onClick, modifier = modifier.heightIn(min = 48.dp)) { Text(label, maxLines = 1) }
}

@Composable
private fun SwitchRow(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
  Row(
      modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(modifier = Modifier.weight(1f)) {
      Text(title, style = MaterialTheme.typography.bodyLarge)
      Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Switch(checked = checked, onCheckedChange = onChange)
  }
}
