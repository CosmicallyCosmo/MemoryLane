package com.memorylane.glasses

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Everything the wearer hears. Sound goes to whatever the phone is routed to, which is the
 * glasses' open-ear speakers once they are connected.
 *
 * Two voices, kept strictly apart: family recordings are played exactly as recorded, and a
 * neutral system voice reads fixed lines and words the family typed. No one's voice is ever
 * generated.
 */
class Narrator(context: Context) {
  private val ready = CompletableDeferred<Boolean>()
  private val pending = ConcurrentHashMap<String, () -> Unit>()
  private var player: MediaPlayer? = null

  @Volatile private var busy = false
  @Volatile private var quietSince = 0L

  private val attributes =
      AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()

  private val tts: TextToSpeech =
      TextToSpeech(context.applicationContext) { status -> ready.complete(status == TextToSpeech.SUCCESS) }

  init {
    tts.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String?) = Unit

          override fun onDone(utteranceId: String?) {
            pending.remove(utteranceId)?.invoke()
          }

          @Deprecated("Deprecated in Java")
          override fun onError(utteranceId: String?) {
            pending.remove(utteranceId)?.invoke()
          }

          override fun onStop(utteranceId: String?, interrupted: Boolean) {
            pending.remove(utteranceId)?.invoke()
          }
        },
    )
  }

  /**
   * True while something is playing and for a moment afterwards. The microphone hears the
   * speakers, so anything transcribed during this window is our own voice, not a question.
   */
  fun isAudible(): Boolean = busy || SystemClock.elapsedRealtime() - quietSince < 900

  /** Speaks a line in the neutral voice and returns when it has finished. */
  suspend fun say(text: String) {
    if (text.isBlank()) return
    if (withTimeoutOrNull(3000) { ready.await() } != true) return
    tts.setAudioAttributes(attributes)
    tts.setLanguage(Locale.getDefault())
    // A little slower than default: easier to follow, and less startling.
    tts.setSpeechRate(0.9f)
    val id = UUID.randomUUID().toString()
    busy = true
    try {
      suspendCancellableCoroutine { continuation ->
        pending[id] = { if (continuation.isActive) continuation.resume(Unit) }
        continuation.invokeOnCancellation {
          pending.remove(id)
          tts.stop()
        }
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
          pending.remove(id)?.invoke()
        }
      }
    } finally {
      busy = false
      quietSince = SystemClock.elapsedRealtime()
    }
  }

  /**
   * How far into the family recording playback has got, in milliseconds, or null when none
   * is playing. Only meaningful once play's onStart has been called.
   */
  fun position(): Int? = player?.let { runCatching { it.currentPosition }.getOrNull() }

  /**
   * Plays a family recording from a file path or URL. Returns false if it could not play.
   * [onStart] is told the recording's length in milliseconds (not above zero if unknown) as
   * it starts.
   */
  suspend fun play(source: String, onStart: (durationMs: Int) -> Unit = {}): Boolean {
    busy = true
    try {
      return suspendCancellableCoroutine { continuation ->
        val mediaPlayer = MediaPlayer()
        player = mediaPlayer
        fun finish(ok: Boolean) {
          runCatching { mediaPlayer.release() }
          if (player === mediaPlayer) player = null
          if (continuation.isActive) continuation.resume(ok)
        }
        continuation.invokeOnCancellation {
          runCatching { mediaPlayer.release() }
          if (player === mediaPlayer) player = null
        }
        try {
          mediaPlayer.setAudioAttributes(attributes)
          mediaPlayer.setDataSource(source)
          mediaPlayer.setOnCompletionListener { finish(true) }
          mediaPlayer.setOnErrorListener { _, _, _ ->
            finish(false)
            true
          }
          mediaPlayer.setOnPreparedListener {
            it.start()
            onStart(it.duration)
          }
          mediaPlayer.prepareAsync()
        } catch (e: Exception) {
          finish(false)
        }
      }
    } finally {
      busy = false
      quietSince = SystemClock.elapsedRealtime()
    }
  }

  fun shutdown() {
    runCatching { player?.release() }
    tts.shutdown()
  }
}
