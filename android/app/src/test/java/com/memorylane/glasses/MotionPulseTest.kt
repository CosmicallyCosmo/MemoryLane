package com.memorylane.glasses

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pulse estimator against made-up head motion. This shows the arithmetic finds a beat that
 * was put there, and refuses when there is none. It says nothing about a real head.
 */
class MotionPulseTest {
  /** Every reading the estimator gives for a recording, with the second it came at. */
  private fun readings(samples: List<SyntheticSample>): List<Pair<Int, Int?>> {
    val estimator = PulseEstimator()
    val out = mutableListOf<Pair<Int, Int?>>()
    samples.forEachIndexed { i, s ->
      val bpm = estimator.add(s.ax, s.ay, s.az, s.gx, s.gy, s.gz)
      if ((i + 1) % 60 == 0 && i + 1 >= 600) out += (i + 1) / 60 to bpm
    }
    return out
  }

  @Test
  fun findsASteadyBeatAcrossTheUsualRange() {
    for (bpm in listOf(52.0, 60.0, 68.0, 75.0, 88.0, 104.0, 126.0)) {
      val got = readings(syntheticHeadMotion(30, random = Random(bpm.toInt())) { bpm })
      val heard = got.mapNotNull { it.second }
      assertTrue("at $bpm: only ${heard.size} of ${got.size} seconds gave a reading", heard.size >= got.size * 0.8)
      assertTrue("at $bpm: got $heard", heard.all { near(it, bpm) })
    }
  }

  @Test
  fun findsABeatAThirdAsStrong() {
    // About 0.004 rad/s of ringing a beat, against sensor noise of 0.0015.
    for (bpm in listOf(58.0, 72.0, 96.0)) {
      val got = readings(syntheticHeadMotion(30, random = Random(bpm.toInt()), beat = 0.3) { bpm })
      val heard = got.mapNotNull { it.second }
      assertTrue("at $bpm: only ${heard.size} of ${got.size} seconds gave a reading", heard.size >= got.size * 0.6)
      assertTrue("at $bpm: got $heard", heard.all { near(it, bpm) })
    }
  }

  @Test
  fun followsARiseAndTheFallAfterIt() {
    // Resting at 66, climbing to 82 around the 35th second, and settling again.
    val rate = { t: Double -> 66 + 16 * Math.exp(-((t - 35) / 9).let { it * it }) }
    val got = readings(syntheticHeadMotion(75) { rate(it) }).filter { it.second != null }
    val early = got.filter { it.first in 12..18 }.map { it.second!! }
    val peak = got.filter { it.first in 36..44 }.map { it.second!! }
    val late = got.filter { it.first in 68..75 }.map { it.second!! }
    assertTrue("early $early", early.isNotEmpty() && early.all { it in 63..70 })
    assertTrue("peak $peak", peak.isNotEmpty() && peak.max() >= 78)
    assertTrue("late $late", late.isNotEmpty() && late.all { it in 63..71 })
  }

  @Test
  fun saysNothingWhenThereIsNoBeat() {
    val got = readings(syntheticHeadMotion(30, beat = 0.0) { 70.0 })
    assertEquals("readings from noise: $got", 0, got.count { it.second != null })
  }

  @Test
  fun saysNothingWhileTheHeadIsMoving() {
    val estimator = PulseEstimator()
    var last: Int? = 0
    syntheticHeadMotion(20, moving = true) { 70.0 }.forEachIndexed { i, s ->
      val bpm = estimator.add(s.ax, s.ay, s.az, s.gx, s.gy, s.gz)
      if ((i + 1) % 60 == 0 && i + 1 >= 600) {
        last = bpm
        assertNull("second ${(i + 1) / 60}", bpm)
        assertEquals("moving", estimator.reason)
      }
    }
    assertNull(last)
  }

  /** Readings from a [PulseReader] given samples that really arrive [fs] a second. */
  private fun read(fs: Double, bpm: Double, seconds: Int = 40, stamp: (Int) -> Long = { (it * 1e9 / fs).toLong() }): Pair<PulseReader, List<Int>> {
    val reader = PulseReader()
    val heard = mutableListOf<Int>()
    syntheticHeadMotion(seconds, fs = fs) { bpm }.forEachIndexed { i, s ->
      reader.add(stamp(i), s.ax, s.ay, s.az, s.gx, s.gy, s.gz)?.let { heard += it }
    }
    return reader to heard
  }

  @Test
  fun measuresTheRateSamplesReallyArriveAt() {
    // Asked for 60 a second, sent 30: the answer must still be the true rate, not double it.
    for (bpm in listOf(60.0, 72.0, 90.0)) {
      val (reader, heard) = read(fs = 30.0, bpm = bpm)
      assertEquals(30.0, reader.rate, 0.5)
      assertTrue("at $bpm from 30 a second: got $heard", heard.size >= 15 && heard.all { near(it, bpm) })
    }
    val (full, heard) = read(fs = 60.0, bpm = 72.0)
    assertEquals(60.0, full.rate, 0.5)
    assertTrue("got $heard", heard.size >= 15 && heard.all { near(it, 72.0) })
  }

  @Test
  fun givesNothingWhenSamplesArriveTooSlowly() {
    val (reader, heard) = read(fs = 15.0, bpm = 72.0)
    assertTrue(reader.tooSlow)
    assertEquals("too few samples", reader.reason)
    assertEquals(emptyList<Int>(), heard)
  }

  @Test
  fun trustsTheRateAskedForWhenTheClockMakesNoSense() {
    val (reader, heard) = read(fs = 60.0, bpm = 72.0, stamp = { 0L })
    assertEquals(60.0, reader.rate, 0.0)
    assertTrue("got $heard", heard.size >= 15 && heard.all { near(it, 72.0) })
  }

  @Test
  fun aSessionWithALongGapInItIsNotSent() {
    var now = 0L
    val monitor = HeartMonitor { now }
    repeat(10) {
      monitor.add(68)
      now += 1000
    }
    monitor.begin()
    repeat(20) {
      monitor.add(70)
      now += 1000
    }
    assertEquals(10, monitor.end("glasses")!!.getJSONArray("samples").length())

    monitor.begin()
    repeat(6) {
      monitor.add(70)
      now += 1000
    }
    now += 20_000 // the wearer got up and walked about
    repeat(10) {
      monitor.add(74)
      now += 1000
    }
    assertNull(monitor.end("glasses"))
  }

  @Test
  fun aShortGapIsBridgedWithTheLastReading() {
    var now = 0L
    val monitor = HeartMonitor { now }
    repeat(10) {
      monitor.add(68)
      now += 1000
    }
    monitor.begin()
    repeat(6) {
      monitor.add(70)
      now += 1000
    }
    now += 4_000
    repeat(8) {
      monitor.add(76)
      now += 1000
    }
    val samples = monitor.end("glasses")!!.getJSONArray("samples")
    assertEquals(9, samples.length())
    assertEquals(listOf(70, 70, 70, 70, 70, 76, 76, 76, 76), (0 until samples.length()).map { samples.getInt(it) })
  }
}
