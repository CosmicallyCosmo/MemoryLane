package com.memorylane.glasses

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import android.view.TextureView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.meta.wearable.dat.camera.types.VideoFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext

// The simulated glasses' camera, drawn behind the lens preview.
//
// The stream arrives compressed (H.264 or H.265, Annex B) and goes straight into the phone's
// video decoder, which draws into a TextureView. Nothing is converted or copied per pixel on the
// CPU. A TextureView, unlike a SurfaceView, is drawn with the rest of the window, so the lens
// preview above it can still add its light to the picture (BlendMode.SCREEN).

/** One compressed frame, copied out of the SDK's buffer. */
class EncodedFrame(val data: ByteArray, val width: Int, val height: Int, val timeUs: Long, val config: Boolean)

/** The camera's compressed frames, for whatever is drawing them. */
class CameraFeed {
  // A decoder that falls behind loses frames and waits for the next key frame.
  private val _frames = MutableSharedFlow<EncodedFrame>(extraBufferCapacity = 30, onBufferOverflow = BufferOverflow.DROP_OLDEST)
  val frames: SharedFlow<EncodedFrame> = _frames.asSharedFlow()

  /** The stream's last codec configuration: a decoder that starts late needs it first. */
  @Volatile var config: EncodedFrame? = null
    private set

  fun push(frame: VideoFrame) {
    if (!frame.isCompressed) return
    val source = frame.buffer.duplicate()
    val data = ByteArray(source.remaining()).also { source.get(it) }
    val encoded = EncodedFrame(data, frame.width, frame.height, frame.presentationTimeUs, frame.isCodecConfig)
    if (encoded.config) config = encoded
    _frames.tryEmit(encoded)
  }

  /** The stream stopped: its configuration does not apply to the next one. */
  fun reset() {
    config = null
  }
}

@Composable
fun CameraUnderlay(feed: CameraFeed, modifier: Modifier = Modifier) {
  var surface by remember { mutableStateOf<Surface?>(null) }
  var view by remember { mutableStateOf<CroppingTextureView?>(null) }
  AndroidView(
      factory = { context ->
        CroppingTextureView(context).apply {
          surfaceTextureListener =
              object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                  surface = Surface(texture)
                }

                override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit

                override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                  surface?.release()
                  surface = null
                  return true
                }

                override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
              }
          view = this
        }
      },
      modifier = modifier,
  )
  val target = surface ?: return
  LaunchedEffect(target) {
    val decoder = FrameDecoder(target) { width, height -> view?.post { view?.setPictureSize(width, height) } }
    try {
      withContext(Dispatchers.Default) {
        feed.config?.let { decoder.decode(it) }
        feed.frames.collect { decoder.decode(it) }
      }
    } finally {
      decoder.release()
    }
  }
}

/**
 * A TextureView filled with the picture, cropping the overflow, as ContentScale.Crop would. The
 * crop is worked out again whenever the picture or the view changes size: a TextureView on its
 * own stretches the picture to whatever size it is.
 */
private class CroppingTextureView(context: Context) : TextureView(context) {
  private var pictureWidth = 0
  private var pictureHeight = 0

  fun setPictureSize(width: Int, height: Int) {
    pictureWidth = width
    pictureHeight = height
    crop()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    crop()
  }

  private fun crop() {
    if (width == 0 || height == 0 || pictureWidth == 0 || pictureHeight == 0) return
    val scale = maxOf(width.toFloat() / pictureWidth, height.toFloat() / pictureHeight)
    // Undo the stretch to the view's size, then scale both ways evenly.
    setTransform(
        Matrix().apply {
          setScale(pictureWidth * scale / width, pictureHeight * scale / height, width / 2f, height / 2f)
        },
    )
  }
}

/**
 * A MediaCodec decoder fed one compressed frame at a time, drawing to a surface. [onSize] gets
 * the picture's shape as the decoder puts it out, which is what is drawn: the size the stream
 * is labelled with need not be.
 */
private class FrameDecoder(private val surface: Surface, private val onSize: (Int, Int) -> Unit) {
  private var codec: MediaCodec? = null
  private var mime: String? = null
  private var width = 0
  private var height = 0
  private var config: ByteArray? = null
  private var waitingForKeyFrame = true
  private val info = MediaCodec.BufferInfo()

  fun decode(frame: EncodedFrame) {
    try {
      if (frame.config) {
        configure(frame)
        return
      }
      val active = codec ?: return
      if (waitingForKeyFrame) {
        if (!Nal.isKeyFrame(frame.data, mime)) return
        waitingForKeyFrame = false
      }
      // Finished pictures go out first, so the decoder has room for the next frame.
      drain(active)
      if (!queue(active, frame.data, frame.timeUs, 0)) waitingForKeyFrame = true
      drain(active)
    } catch (error: Exception) {
      // A codec error costs the picture until the next configuration, never the app.
      Log.w(TAG, "Camera view decoder: ${error.message}")
      release()
    }
  }

  private fun configure(frame: EncodedFrame) {
    val type = Nal.mimeOf(frame.data) ?: return
    if (codec != null && type == mime && frame.width == width && frame.height == height && frame.data.contentEquals(config)) {
      return
    }
    release()
    mime = type
    width = frame.width
    height = frame.height
    config = frame.data
    codec =
        MediaCodec.createDecoderByType(type).apply {
          configure(MediaFormat.createVideoFormat(type, frame.width, frame.height), surface, null, 0)
          start()
        }
    queue(codec!!, frame.data, frame.timeUs, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
    waitingForKeyFrame = true
  }

  /** The visible picture (the decoder's crop rectangle), widened or narrowed by its pixel shape. */
  private fun pictureSize(format: MediaFormat) {
    val coded = format.getInteger(MediaFormat.KEY_WIDTH) to format.getInteger(MediaFormat.KEY_HEIGHT)
    val visible =
        if (format.containsKey("crop-right") && format.containsKey("crop-bottom")) {
          (format.getInteger("crop-right") - format.getInteger("crop-left") + 1) to
              (format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1)
        } else {
          coded
        }
    val sarWidth = format.getInteger(MediaFormat.KEY_PIXEL_ASPECT_RATIO_WIDTH, 1).coerceAtLeast(1)
    val sarHeight = format.getInteger(MediaFormat.KEY_PIXEL_ASPECT_RATIO_HEIGHT, 1).coerceAtLeast(1)
    val shown = visible.first * sarWidth / sarHeight to visible.second
    Log.i(TAG, "Camera picture ${shown.first}x${shown.second} (decoded ${coded.first}x${coded.second}, " +
        "pixels $sarWidth:$sarHeight; the stream says ${width}x$height)")
    onSize(shown.first, shown.second)
  }

  /** False if the decoder had no room: the frame is lost. */
  private fun queue(codec: MediaCodec, data: ByteArray, timeUs: Long, flags: Int): Boolean {
    val index = codec.dequeueInputBuffer(INPUT_WAIT_US)
    if (index < 0) return false
    val buffer = codec.getInputBuffer(index) ?: return false
    buffer.clear()
    buffer.put(data)
    codec.queueInputBuffer(index, 0, data.size, timeUs, flags)
    return true
  }

  private fun drain(codec: MediaCodec) {
    while (true) {
      val index = codec.dequeueOutputBuffer(info, 0)
      if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
        pictureSize(codec.outputFormat)
        continue
      }
      if (index < 0) return
      codec.releaseOutputBuffer(index, true)
    }
  }

  fun release() {
    codec?.let { runCatching { it.stop() }; runCatching { it.release() } }
    codec = null
    config = null
    waitingForKeyFrame = true
  }

  private companion object {
    const val TAG = "MemoryLane"
    const val INPUT_WAIT_US = 10_000L
  }
}

/** Just enough of H.264 and H.265 to start a decoder: the codec, and where key frames are. */
private object Nal {
  private const val AVC = MediaFormat.MIMETYPE_VIDEO_AVC
  private const val HEVC = MediaFormat.MIMETYPE_VIDEO_HEVC

  /** The first byte of each NAL unit after an Annex B start code. */
  private fun headers(data: ByteArray): Sequence<Int> = sequence {
    var i = 0
    while (i + 3 < data.size) {
      if (data[i] == 0.toByte() && data[i + 1] == 0.toByte() && data[i + 2] == 1.toByte()) {
        yield(data[i + 3].toInt() and 0xFF)
        i += 3
      } else {
        i++
      }
    }
  }

  /** From a configuration frame: H.265 opens with a VPS (type 32), H.264 with an SPS (type 7). */
  fun mimeOf(config: ByteArray): String? {
    val first = headers(config).firstOrNull() ?: return null
    return when {
      ((first shr 1) and 0x3F) in 32..34 -> HEVC
      (first and 0x1F) in 7..8 -> AVC
      else -> null
    }
  }

  fun isKeyFrame(data: ByteArray, mime: String?): Boolean =
      headers(data).any { header ->
        when (mime) {
          HEVC -> ((header shr 1) and 0x3F) in 16..23 // IRAP pictures
          AVC -> (header and 0x1F) == 5 // IDR
          else -> false
        }
      }
}
