package com.memorylane.glasses

/**
 * What the wearer means when the display offers two choices ("See memory" or "Not now", "Yes"
 * or "Not now"). Nobody should have to remember the exact words: anything that plainly says one
 * of them picks it. Anything unclear picks neither, and the buttons still work.
 */

/** "Where did we play golf?" is a question, never a yes; "show me who that is" asks who. */
private val ASKS = Regex("^(whose|what|where|when|how)\\b|^why\\b(?! not\\b)|\\bwho\\b")

private val NO =
    Regex(
        "^(no|nope|nah|na)\\b|\\b(not now|not today|not right now|not yet|maybe later|later|no thanks|no thank you|" +
            "don'?t|do not|never mind|nevermind|leave it|skip it|i'?m fine|i'?m ok|i'?m okay)\\b",
    )

private val YES =
    Regex(
        "^(yes|yeah|yea|yep|yup|ya|aye|ok|okay|sure|alright|all right|please|go on|go ahead|lets|let's|why not|" +
            "of course|definitely|absolutely|certainly|lovely|great)\\b|" +
            "\\b(play|replay|show|see|watch|open|walk|start|go ahead|go on|please do|love to|like to|would like|want to)\\b",
    )

/** "Play it", "the memory lane, please", "again": play the memory that is open once more. */
private val AGAIN =
    Regex("^again$|say that again|\\b(play|replay|watch|once more|one more time|from the (start|beginning))\\b")

/** The wearer said no to the choice on the display. */
fun declines(lower: String): Boolean = NO.containsMatchIn(lower.trim())

/** The wearer said yes to the choice on the display. A no, or a question, is never a yes. */
fun affirms(lower: String): Boolean {
  val said = lower.trim()
  return !ASKS.containsMatchIn(said) && !declines(said) && YES.containsMatchIn(said)
}

/** With a memory open, the wearer asked for it again. */
fun asksAgain(lower: String): Boolean {
  val said = lower.trim()
  return !ASKS.containsMatchIn(said) && !declines(said) && AGAIN.containsMatchIn(said)
}
