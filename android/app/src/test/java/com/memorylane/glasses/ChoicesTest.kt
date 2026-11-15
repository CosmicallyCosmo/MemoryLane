package com.memorylane.glasses

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Yes or no to a choice on the display, said however the wearer says it. */
class ChoicesTest {
  @Test
  fun anythingThatPlainlyMeansYesIsYes() {
    for (said in listOf(
        "yes", "yes please", "yeah", "ok", "show me", "see memory", "go on", "please", "all right",
        "play it", "play the memory lane", "yes please, play it", "sure", "i'd love to", "let's see it",
        "can i see it", "watch it", "open it", "walk down memory lane", "why not", "of course",
    )) {
      assertTrue(said, affirms(said))
      assertFalse(said, declines(said))
    }
  }

  @Test
  fun anythingThatPlainlyMeansNoIsNo() {
    for (said in listOf("no", "no thanks", "no thank you", "not now", "not today", "nope", "nah", "maybe later", "no, don't play it", "i'm fine")) {
      assertTrue(said, declines(said))
      assertFalse(said, affirms(said))
    }
  }

  @Test
  fun questionsAndOtherTalkAreNeither() {
    for (said in listOf("who is that", "show me who that is", "what's this", "where did we play golf", "is it raining", "hello")) {
      assertFalse(said, affirms(said))
    }
  }

  @Test
  fun aMemoryIsPlayedAgainWhenAskedForAgain() {
    for (said in listOf("again", "play it", "play it again", "say that again", "watch it", "once more", "one more time", "replay")) {
      assertTrue(said, asksAgain(said))
    }
    for (said in listOf("where did we play golf", "who gave me this", "don't play it", "when was this")) {
      assertFalse(said, asksAgain(said))
    }
  }
}
