package com.memorylane.glasses

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

// Heart rate from the glasses' motion sensors.
//
// Each heartbeat pushes blood up into the head and the head answers with a tiny recoil, a
// fraction of a degree a second, which a gyroscope and accelerometer resting on the nose and
// ears can pick up while the wearer is still (ballistocardiography). The steps follow the
// published approach for head-worn devices: keep the short ringing each beat leaves (around
// 10 to 13 Hz), take its strength across the three axes, and find how often that strength
// repeats within the range a heart can beat at.
//
// Nothing here knows about Android or the Meta SDK, so it can be tested on its own. It has been
// checked against made-up signals only (see MotionPulseTest), never against a person.

/** A second-order filter section (RBJ cookbook), run one sample at a time. */
private class Biquad(private val b0: Double, private val b1: Double, private val b2: Double, private val a1: Double, private val a2: Double) {
  private var x1 = 0.0
  private var x2 = 0.0
  private var y1 = 0.0
  private var y2 = 0.0

  fun step(x: Double): Double {
    val y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    return y
  }

  companion object {
    fun bandPass(fs: Double, centre: Double, q: Double): Biquad {
      val w = 2 * PI * centre / fs
      val alpha = sin(w) / (2 * q)
      val a0 = 1 + alpha
      return Biquad(alpha / a0, 0.0, -alpha / a0, -2 * cos(w) / a0, (1 - alpha) / a0)
    }

    fun highPass(fs: Double, cutoff: Double): Biquad {
      val w = 2 * PI * cutoff / fs
      val alpha = sin(w) / (2 * 0.7071)
      val a0 = 1 + alpha
      val c = cos(w)
      return Biquad((1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0)
    }

    fun lowPass(fs: Double, cutoff: Double): Biquad {
      val w = 2 * PI * cutoff / fs
      val alpha = sin(w) / (2 * 0.7071)
      val a0 = 1 + alpha
      val c = cos(w)
      return Biquad((1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0)
    }
  }
}

/** One three-axis sensor turned into a single "how hard is the head ringing" signal. */
private class BeatStrength(fs: Double, size: Int) {
  private val ring = Array(3) { Biquad.bandPass(fs, centre = 11.5, q = 3.0) }
  private val slow = Biquad.highPass(fs, 0.75)
  private val fast = Biquad.lowPass(fs, 2.5)
  val recent = DoubleArray(size)

  fun add(x: Double, y: Double, z: Double, at: Int) {
    val rx = ring[0].step(x)
    val ry = ring[1].step(y)
    val rz = ring[2].step(z)
    recent[at] = fast.step(slow.step(sqrt(rx * rx + ry * ry + rz * rz)))
  }
}

/**
 * Feed it every motion sample; about once a second it answers with beats a minute, or null when
 * the wearer is moving too much or no steady beat can be found. It never guesses.
 */
class PulseEstimator(private val fs: Double = 60.0) {
  private val size = (fs * WINDOW_SEC).toInt()
  /** Samples between answers: about a second's worth. */
  private val everyN = fs.roundToInt().toLong()
  private val gyro = BeatStrength(fs, size)
  private val accel = BeatStrength(fs, size)
  private val turning = DoubleArray(size)
  private var count = 0L
  private val lately = ArrayDeque<Int>()

  /** How sure the last answer was, 0 to 1: how closely the beat pattern repeats. */
  var confidence = 0.0
    private set

  /** Why the last answer was null: "moving", "no steady beat", or "" when there was one. */
  var reason = ""
    private set

  /**
   * [ax],[ay],[az] in m/s², [gx],[gy],[gz] in rad/s. Returns a reading once a second after the
   * first [WINDOW_SEC] seconds, and null in between and whenever there is nothing honest to say.
   */
  fun add(ax: Double, ay: Double, az: Double, gx: Double, gy: Double, gz: Double): Int? {
    val at = (count % size).toInt()
    gyro.add(gx, gy, gz, at)
    accel.add(ax, ay, az, at)
    turning[at] = sqrt(gx * gx + gy * gy + gz * gz)
    count++
    if (count < size || count % everyN != 0L) return null

    // Walking, nodding or turning swamps a heartbeat hundreds of times over.
    if (turning.sum() / size > STILL_BELOW) {
      lately.clear()
      confidence = 0.0
      reason = "moving"
      return null
    }
    val start = (count % size).toInt()
    val best = listOf(gyro, accel).mapNotNull { period(it.recent, start) }.maxByOrNull { it.second }
    if (best == null || best.second < SURE_ABOVE) {
      lately.clear()
      confidence = best?.second ?: 0.0
      reason = "no steady beat"
      return null
    }
    confidence = best.second
    reason = ""
    lately.addLast((60.0 * fs / best.first).roundToInt())
    if (lately.size > 5) lately.removeFirst()
    return lately.sorted()[lately.size / 2]
  }

  /**
   * How many samples apart the signal best repeats, within the range a heart beats at, and how
   * closely (0 to 1). [start] is where the oldest sample sits in the circular buffer.
   */
  private fun period(buffer: DoubleArray, start: Int): Pair<Double, Double>? {
    val x = DoubleArray(size) { buffer[(start + it) % size] }
    val mean = x.average()
    var power = 0.0
    for (i in x.indices) {
      x[i] -= mean
      power += x[i] * x[i]
    }
    if (power <= 0.0) return null
    val shortest = (fs * 60 / MAX_BPM).toInt()
    val longest = (fs * 60 / MIN_BPM).toInt()
    val match = DoubleArray(longest + 2)
    for (lag in shortest - 1..longest + 1) {
      var sum = 0.0
      for (i in 0 until size - lag) sum += x[i] * x[i + lag]
      // Scaled so a perfect repeat scores 1 whatever the lag.
      match[lag] = sum / power * size / (size - lag)
    }
    var top = 0.0
    for (lag in shortest..longest) if (match[lag] > match[lag - 1] && match[lag] >= match[lag + 1] && match[lag] > top) top = match[lag]
    if (top <= 0.0) return null
    // A beat also repeats every two and three beats. Take the shortest gap that matches nearly as well.
    for (lag in shortest..longest) {
      if (match[lag] > match[lag - 1] && match[lag] >= match[lag + 1] && match[lag] >= 0.8 * top) {
        // The true peak usually falls between two samples.
        val curve = match[lag - 1] - 2 * match[lag] + match[lag + 1]
        val shift = if (curve == 0.0) 0.0 else 0.5 * (match[lag - 1] - match[lag + 1]) / curve
        return (lag + shift) to match[lag]
      }
    }
    return null
  }

  companion object {
    const val WINDOW_SEC = 10
    const val MIN_BPM = 42
    const val MAX_BPM = 150
    /** Average turning speed, rad/s, above which the wearer counts as moving (about 3° a second). */
    const val STILL_BELOW = 0.05
    const val SURE_ABOVE = 0.35
  }
}

/**
 * A [PulseEstimator] that first finds out how fast samples really arrive. The glasses are asked
 * for 60 a second, but may send fewer, and an estimator told the wrong rate would be wrong by
 * the same proportion. The first two seconds' timestamps settle it. Below [MIN_RATE] a second
 * the ringing a beat leaves cannot be seen at all, and no reading is given.
 */
class PulseReader(private val askedFor: Double = 60.0) {
  private val first = ArrayList<Long>()
  private var estimator: PulseEstimator? = null

  /** Samples a second as measured, or 0 until that is known. */
  var rate = 0.0
    private set

  val tooSlow
    get() = rate > 0 && rate < MIN_RATE

  val reason
    get() = if (tooSlow) "too few samples" else estimator?.reason.orEmpty()

  /** [timestampNs] is the sample's own time, from the device's clock. The rest is as for [PulseEstimator.add]. */
  fun add(timestampNs: Long, ax: Double, ay: Double, az: Double, gx: Double, gy: Double, gz: Double): Int? {
    val ready =
        estimator
            ?: run {
              first.add(timestampNs)
              if (first.size < SETTLE_OVER) return null
              val seconds = (first.last() - first.first()) / 1e9
              val measured = if (seconds > 0) (first.size - 1) / seconds else 0.0
              // A clock that makes no sense is no reason to distrust the rate that was asked for.
              rate = if (measured in 4.0..240.0) measured else askedFor
              PulseEstimator(rate).also { estimator = it }
            }
    if (tooSlow) return null
    return ready.add(ax, ay, az, gx, gy, gz)
  }

  companion object {
    const val SETTLE_OVER = 120
    /** A beat rings at 10 to 13 Hz, so anything under about 28 samples a second cannot show it. */
    const val MIN_RATE = 28.0
  }
}

/** One made-up motion sample: accelerometer in m/s², gyroscope in rad/s. */
class SyntheticSample(val ax: Double, val ay: Double, val az: Double, val gx: Double, val gy: Double, val gz: Double)

/**
 * Made-up head motion with a heartbeat in it, for Mock Device Kit and the tests: gravity, slow
 * breathing sway, sensor noise, and at each beat a short ringing that dies away. [bpmAt] gives
 * the heart rate at each moment, so a recording can hold a rise. [moving] adds the kind of
 * turning a real head does, which should stop any reading.
 */
fun syntheticHeadMotion(
    seconds: Int,
    fs: Double = 60.0,
    random: Random = Random(1),
    beat: Double = 1.0,
    moving: Boolean = false,
    bpmAt: (Double) -> Double,
): List<SyntheticSample> {
  val total = (seconds * fs).toInt()
  val pulse = DoubleArray(total)
  var t = 0.0
  while (t < seconds) {
    val from = (t * fs).toInt()
    // Each beat: a 11 Hz wobble that fades within about a fifth of a second.
    for (i in from until minOf(total, from + (0.4 * fs).toInt())) {
      val since = i / fs - t
      pulse[i] += exp(-since / 0.07) * sin(2 * PI * 11.0 * since)
    }
    // No heart keeps perfect time.
    t += 60.0 / bpmAt(t) * (1 + random.nextDouble(-0.02, 0.02))
  }
  fun noise(size: Double) = random.nextDouble(-size, size)
  return List(total) { i ->
    val at = i / fs
    val breath = sin(2 * PI * 0.25 * at)
    val turn = if (moving) 0.4 * sin(2 * PI * 0.7 * at) + noise(0.2) else 0.0
    SyntheticSample(
        ax = 0.3 + 0.02 * beat * pulse[i] + noise(0.004),
        ay = 9.78 + 0.03 * breath + 0.05 * beat * pulse[i] + noise(0.004),
        az = 0.9 + 0.02 * breath + noise(0.004),
        gx = 0.004 * breath + 0.012 * beat * pulse[i] + noise(0.0015) + turn,
        gy = 0.004 * beat * pulse[i] + noise(0.0015) + turn / 2,
        gz = 0.002 * breath + noise(0.0015),
    )
  }
}

/** True when two rates are within [by] beats a minute of each other. */
internal fun near(a: Int, b: Double, by: Int = 3) = abs(a - b) <= by
