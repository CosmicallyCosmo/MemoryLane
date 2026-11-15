package com.memorylane.glasses

import android.graphics.Bitmap
import com.meta.wearable.dat.display.views.ActionRole
import com.meta.wearable.dat.display.views.Alignment
import com.meta.wearable.dat.display.views.ButtonStyle
import com.meta.wearable.dat.display.views.ContentScope
import com.meta.wearable.dat.display.views.CornerRadius
import com.meta.wearable.dat.display.views.Direction
import com.meta.wearable.dat.display.views.FlexBoxBackground
import com.meta.wearable.dat.display.views.FlexBoxScope
import com.meta.wearable.dat.display.views.IconName
import com.meta.wearable.dat.display.views.ImageSize
import com.meta.wearable.dat.display.views.TextColor
import com.meta.wearable.dat.display.views.TextStyle

/*
 * What the wearer sees on the 600x600 glasses display.
 *
 * The look is Meta's own: these are the toolkit's native components, so type, card material,
 * buttons and focus ring match the rest of the glasses and nothing here sets a font or colour.
 * What is ours is how little there is of it:
 *
 * - One idea per screen: a title, at most one short line under it, at most two choices.
 * - The first choice is the safe, obvious one and is where focus lands, so a single pinch
 *   does the expected thing.
 * - What is spoken is not written out underneath: a hello or a story is heard, and the
 *   display shows only whose it is. Everything shown is still spoken.
 * - The display is additive: unlit pixels are see-through. Text sits straight on the glass
 *   with no panel behind it, so the wearer's hands and the keepsake stay in view. Only the
 *   rows of the memory list are cards, because they are things to press.
 */

typealias Screen = ContentScope.() -> Unit

/** Display text has to be read at a glance; long stories are spoken, not shown in full. */
private fun caption(text: String, limit: Int = 90): String {
  val clean = text.trim().replace(Regex("\\s+"), " ")
  if (clean.length <= limit) return clean
  val cut = clean.take(limit)
  return cut.substring(0, cut.lastIndexOf(' ').takeIf { it > limit / 2 } ?: limit).trimEnd(',', ';', ':') + "…"
}

/**
 * A story cut into lines to show one at a time while it is heard: whole sentences, and a
 * sentence too long to take in at a glance broken where it pauses (a comma, a dash), so no
 * line is more than about two rows of the display.
 */
fun storyLines(text: String, limit: Int = 100): List<String> {
  val clean = text.trim().replace(Regex("\\s+"), " ")
  if (clean.isEmpty()) return emptyList()
  val lines = mutableListOf<String>()
  for (sentence in clean.split(Regex("(?<=[.!?…])\\s+"))) {
    // A scrap ("Mr.", "Oh!") is not worth a line of its own: it stays with what follows.
    val last = lines.lastOrNull()
    if (last != null && last.length < 20 && last.length + sentence.length < limit) lines[lines.size - 1] = "$last $sentence"
    else lines += sentence
  }
  return lines.flatMap { breakAtPauses(it, limit) }
}

private fun breakAtPauses(sentence: String, limit: Int): List<String> {
  if (sentence.length <= limit) return listOf(sentence)
  // The pause nearest the middle, so the two halves are of a size; failing that, a space.
  val middle = sentence.length / 2
  val pauses = Regex("[,;:–—] ").findAll(sentence).map { it.range.first + 1 }.toList()
  val cut =
      pauses.minByOrNull { kotlin.math.abs(it - middle) }?.takeIf { it in limit / 4..sentence.length - limit / 4 }
          ?: sentence.lastIndexOf(' ', middle).takeIf { it > 0 }
          ?: return listOf(sentence)
  return breakAtPauses(sentence.substring(0, cut).trim(), limit) + breakAtPauses(sentence.substring(cut).trim(), limit)
}

/** A row of at most two choices, centred under the content. */
private fun FlexBoxScope.choices(
    first: Pair<String, () -> Unit>,
    second: Pair<String, () -> Unit>? = null,
) {
  flexBox(direction = Direction.ROW, gap = 8, alignment = Alignment.CENTER) {
    buttonGroup {
      button(first.first, style = ButtonStyle.PRIMARY, onClick = first.second, actionRole = ActionRole.PRIMARY)
      second?.let { (label, action) -> button(label, style = ButtonStyle.OUTLINE, onClick = action) }
    }
  }
}

fun homeScreen(wearerName: String, canListen: Boolean, onLook: () -> Unit, onBrowse: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 16, alignment = Alignment.CENTER, crossAlignment = Alignment.CENTER) {
    // One button. Everything else is asked for out loud: "What's this?", "Who's this?".
    choices("What's this?" to onLook)
  }
}

fun lookingScreen(): Screen = {
  flexBox(direction = Direction.COLUMN, padding = 24, crossAlignment = Alignment.CENTER) {
    text("Looking…", style = TextStyle.BODY, color = TextColor.SECONDARY)
  }
}

/**
 * Something with a memory is in view. Nothing plays until the wearer chooses to see it. With
 * people in the memory, the second choice is "Who's that?" (their hellos); "no", or waiting,
 * still puts it away.
 */
fun offerScreen(title: String, from: String, onSee: () -> Unit, onWho: (() -> Unit)?, onNotNow: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    flexBox(direction = Direction.COLUMN, gap = 4) {
      text(title, style = TextStyle.HEADING)
      if (from.isNotBlank()) text("From $from", style = TextStyle.BODY, color = TextColor.SECONDARY)
    }
    choices("See memory" to onSee, if (onWho != null) "Who's that?" to onWho else "Not now" to onNotNow)
  }
}

/** Who this is: their name and how they are related. Their hello is heard, not written out. */
fun personScreen(person: Person, onSee: (() -> Unit)?, onDone: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    flexBox(direction = Direction.COLUMN, gap = 4) {
      text(person.name, style = TextStyle.HEADING)
      if (person.relationship.isNotBlank()) text(person.relationship, style = TextStyle.BODY, color = TextColor.SECONDARY)
    }
    if (onSee != null) choices("See memory" to onSee, "Done" to onDone) else choices("Done" to onDone)
  }
}

/**
 * A memory. [line] is the part of the story being heard, or its opening when nothing is; it
 * is [lit] (full brightness) while it is being heard. The display has no animation, so a new
 * line is brought in by the two brightnesses the toolkit has: see GlassesViewModel.storyTo.
 */
fun memoryScreen(
    keepsake: Keepsake,
    photo: Bitmap?,
    line: String,
    lit: Boolean,
    canListen: Boolean,
    onQuestion: (Answer) -> Unit,
    onWho: (() -> Unit)?,
    onDone: () -> Unit,
): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    // A photo appears only if the family chose one to show. The keepsake itself is already
    // in the wearer's hands.
    if (photo != null) {
      image(bitmap = photo, sizePreset = ImageSize.FILL, cornerRadius = CornerRadius.MEDIUM)
    }
    flexBox(direction = Direction.COLUMN, gap = 4) {
      // The story is heard, not written out: [line] and [lit] are no longer shown.
      text(keepsake.name, style = TextStyle.HEADING)
    }
    // The voice message or the lane plays on its own; questions are spoken. "Who's that?" plays
    // the hellos of the people in it.
    choices("Done" to onDone, onWho?.let { "Who's that?" to it })
  }
}

fun answerScreen(question: String, words: String, speaker: String, onBack: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    flexBox(direction = Direction.COLUMN, gap = 4) {
      text(caption(words, 120), style = TextStyle.BODY)
      if (speaker.isNotBlank()) text(speaker, style = TextStyle.META, color = TextColor.SECONDARY)
    }
    choices("Back" to onBack)
  }
}

fun messageScreen(
    heading: String,
    body: String,
    primary: Pair<String, () -> Unit>? = null,
    secondary: Pair<String, () -> Unit>? = null,
): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 12, padding = 24, crossAlignment = Alignment.CENTER) {
    text(heading, style = TextStyle.BODY)
    if (body.isNotBlank()) text(body, style = TextStyle.META, color = TextColor.SECONDARY)
    if (primary != null) choices(primary, secondary)
  }
}

/**
 * The wearer's memories as a list. Works with no connection, from what is on the phone (a
 * memory lane then plays by ear).
 */
fun browseScreen(
    keepsakes: List<Keepsake>,
    note: String,
    onOpen: (Keepsake) -> Unit,
    onBack: () -> Unit,
): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 8) {
    if (note.isNotBlank()) {
      flexBox(padding = 12) { text(caption(note, 60), style = TextStyle.META, color = TextColor.SECONDARY) }
    }
    keepsakes.take(4).forEach { keepsake ->
      flexBox(padding = 18, background = FlexBoxBackground.CARD, onClick = { onOpen(keepsake) }) {
        text(keepsake.name, style = TextStyle.BODY)
      }
    }
    choices("Back" to onBack)
  }
}

/** After someone has said hello: would the wearer like to walk through that person's life? */
fun laneOfferScreen(name: String, onYes: () -> Unit, onNotNow: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    flexBox(direction = Direction.COLUMN, gap = 4) {
      text("Memory lane", style = TextStyle.HEADING)
      text("Walk through $name's memories?", style = TextStyle.BODY, color = TextColor.SECONDARY)
    }
    choices("Yes" to onYes, "Not now" to onNotNow)
  }
}

/** One moment of a memory lane, shown before its clip and when there is no picture for it. */
fun laneMomentScreen(year: Int, title: String, onStop: () -> Unit): Screen = {
  flexBox(direction = Direction.COLUMN, gap = 14, padding = 20) {
    flexBox(direction = Direction.COLUMN, gap = 4) {
      text(year.toString(), style = TextStyle.HEADING)
      text(caption(title, 60), style = TextStyle.BODY, color = TextColor.SECONDARY)
    }
    choices("Stop" to onStop)
  }
}
