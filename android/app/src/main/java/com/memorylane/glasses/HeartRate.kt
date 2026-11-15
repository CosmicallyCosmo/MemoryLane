package com.memorylane.glasses

import com.meta.wearable.dat.motion.types.MotionSample
import com.meta.wearable.dat.motion.types.MotionSource
import com.meta.wearable.dat.motion.types.Vector3
import kotlin.math.exp
import kotlin.random.Random
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.json.JSONArray
import org.json.JSONObject

// Heart rate comes from the glasses' own motion sensors (the Device Access Toolkit's Motion
// capability), worked out by PulseEstimator in MotionPulse.kt. This file holds what sits either
// side of that: the made-up motion that simulated glasses replay, a last-resort made-up heart,
// and the monitor that turns readings into one session per memory.

/** Where a session's numbers came from. Sent with it, and shown in the family app. */
const val HEART_FROM_GLASSES = "glasses"
const val HEART_SIMULATED = "simulated"

/**
 * A recording for Mock Device Kit to replay as the glasses' motion: a still head with a heartbeat
 * in it. [riseBy] above zero makes the rate climb to a peak [peakAtSec] in and settle again,
 * which is what simulated glasses replay while a memory is open.
 */
fun mockMotionRecording(seconds: Int, restingBpm: Double, riseBy: Double = 0.0, peakAtSec: Double = 0.0, random: Random = Random.Default): List<MotionSample> {
  val rate = { t: Double -> restingBpm + riseBy * exp(-((t - peakAtSec) / 9.0).let { it * it }) }
  return syntheticHeadMotion(seconds, random = random, bpmAt = rate).mapIndexed { i, s ->
    MotionSample(
        i * 1_000_000_000L / 60,
        Vector3(s.ax.toFloat(), s.ay.toFloat(), s.az.toFloat()),
        Vector3(s.gx.toFloat(), s.gy.toFloat(), s.gz.toFloat()),
        null,
        null,
        MotionSource.GLASSES,
    )
  }
}

/**
 * A made-up heart with no motion behind it: a resting rate that drifts a little, and most times
 * a memory opens, a rise that fades. Used only with simulated glasses, and only if Mock Device
 * Kit's motion replay gives nothing to work with, so a demo still has something to show.
 */
class SimulatedHeartSource(private val random: Random = Random.Default) {
  private val resting = 64 + random.nextInt(9)
  @Volatile private var openedAt = 0L
  @Volatile private var rise = 0
  @Volatile private var peakAfterSec = 0
  /** A rate set by hand, held with no rise of its own; null for the automatic one. */
  @Volatile var fixedBpm: Int? = null

  fun memoryOpened() {
    // Three times in four the rate climbs; otherwise it stays where it was.
    rise = if (random.nextInt(4) < 3) 9 + random.nextInt(10) else 0
    peakAfterSec = 8 + random.nextInt(10)
    openedAt = System.currentTimeMillis()
  }

  fun memoryClosed() {
    openedAt = 0L
  }

  val readings: Flow<Int> = flow {
    var drift = 0.0
    while (true) {
      drift = (drift + random.nextDouble(-0.6, 0.6)).coerceIn(-3.0, 3.0)
      val since = openedAt.takeIf { it > 0 }?.let { (System.currentTimeMillis() - it) / 1000.0 }
      val lift = if (since == null) 0.0 else rise * exp(-((since - peakAfterSec) / 7.0).let { it * it })
      val base = fixedBpm?.let { it + random.nextDouble(-1.0, 1.0) } ?: (resting + drift + lift + random.nextDouble(-1.0, 1.0))
      emit(base.toInt())
      delay(1_000)
    }
  }
}

/**
 * Turns readings into one session per memory opened: the resting rate from just before, and a
 * reading every [EVERY_SEC] seconds while it was open. Readings are held in memory for a minute
 * and then forgotten; only a session leaves this class.
 *
 * Readings stop whenever the wearer moves. A short gap is bridged with the reading before it; a
 * session with a long gap in it is not sent, because most of it would be filled in.
 */
class HeartMonitor(private val now: () -> Long = System::currentTimeMillis) {
  private val recent = ArrayDeque<Pair<Long, Int>>()
  private var resting: Int? = null
  private var samples: MutableList<Int>? = null
  private var beganAt = 0L
  private var broken = false

  @Synchronized
  fun add(bpm: Int) {
    if (bpm !in 30..220) return
    val at = now()
    recent.addLast(at to bpm)
    while (recent.isNotEmpty() && at - recent.first().first > KEEP_MS) recent.removeFirst()
    val taken = samples ?: return
    val slot = ((at - beganAt) / (EVERY_SEC * 1000)).toInt()
    if (slot < taken.size || taken.size >= MAX_SAMPLES) return
    val missed = slot - taken.size
    if (missed > MAX_GAP_SLOTS) broken = true
    repeat(missed) { taken.add(taken.lastOrNull() ?: bpm) }
    taken.add(bpm)
  }

  /** A memory has opened. Without readings from just before there is no resting rate to compare with, and no session. */
  @Synchronized
  fun begin() {
    val at = now()
    val before = recent.filter { at - it.first <= RESTING_OVER_MS }.map { it.second }
    samples = null
    if (before.size < MIN_BEFORE) return
    resting = before.sorted()[before.size / 2]
    samples = mutableListOf()
    beganAt = at
    broken = false
  }

  /** The memory has closed. The session to send, or null if it was too short or too patchy to say anything. */
  @Synchronized
  fun end(source: String): JSONObject? {
    val taken = samples ?: return null
    samples = null
    if (broken || taken.size < MIN_SAMPLES) return null
    return JSONObject()
        .put("restingBpm", resting)
        .put("everySec", EVERY_SEC)
        .put("samples", JSONArray(taken))
        .put("source", source)
  }

  @Synchronized
  fun clear() {
    recent.clear()
    samples = null
  }

  private companion object {
    const val KEEP_MS = 60_000L
    const val RESTING_OVER_MS = 30_000L
    const val MIN_BEFORE = 5
    const val EVERY_SEC = 2
    const val MIN_SAMPLES = 5
    const val MAX_SAMPLES = 300
    /** Eight seconds: about as long as the estimator needs to settle after a movement. */
    const val MAX_GAP_SLOTS = 4
  }
}
