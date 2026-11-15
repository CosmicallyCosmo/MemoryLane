package com.memorylane.glasses

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class Answer(
    val id: String,
    val question: String,
    val text: String,
    val speaker: String,
    val audio: String?,
)

data class Keepsake(
    val id: String,
    val name: String,
    val from: String,
    val introLine: String,
    val story: String,
    val memoryPhotos: List<String>,
    val referencePhotos: List<String>,
    val voiceNote: String?,
    val answers: List<Answer>,
    /** Relatives who appear in this memory. */
    val people: List<String> = emptyList(),
    val addedBy: String? = null,
    /** Photos or a video made into a memory lane, to watch together on the phone. */
    val hasLane: Boolean = false,
    /**
     * The memory lane's glasses copy, if the family has made one: a silent video for the display
     * and its sound apart (the voice message with music). Null for a memory that is a voice only.
     */
    val filmVideo: String? = null,
    val filmAudio: String? = null,
) {
  val hasFilm: Boolean
    get() = filmVideo != null || filmAudio != null
}

/** A relative, as the wearer meets them: a name, how they are related, and their own hello. */
data class Person(
    val id: String,
    val name: String,
    val relationship: String,
    val introText: String,
    val introAudio: String?,
    /**
     * Their hello as a film, if the family has made its glasses copy: a silent video for the
     * display and its sound, played by the phone.
     */
    val filmVideo: String? = null,
    val filmAudio: String? = null,
    /** Their memory lane, if the family added one: moments from their life, in order of year. */
    val lane: List<LaneClip> = emptyList(),
)

/** One moment of a memory lane. [lens] is its display-sized silent clip, if there is one. */
data class LaneClip(val year: Int, val title: String, val lens: String?)

data class Pack(
    val version: String,
    val wearerName: String,
    val carerName: String,
    val wearerAgreed: Boolean,
    /** The family switched on noting heart rate while a memory is open. */
    val heartRate: Boolean = false,
    val keepsakes: List<Keepsake>,
    val people: List<Person> = emptyList(),
    /** Answers to everyday questions that are not about any one object. */
    val answers: List<Answer> = emptyList(),
) {
  fun keepsake(id: String?) = keepsakes.firstOrNull { it.id == id }

  fun person(id: String?) = people.firstOrNull { it.id == id }

  /** The relative called this, by their whole name or their first name. */
  fun personNamed(name: String): Person? {
    val wanted = name.trim().lowercase()
    if (wanted.isEmpty()) return null
    return people.firstOrNull { it.name.lowercase() == wanted }
        ?: people.firstOrNull { it.name.lowercase().substringBefore(' ') == wanted }
  }
}

data class LookResult(
    val matchId: String?,
    val objectLabel: String,
    val latencyMs: Long,
)

data class AskResult(
    val kind: String,
    val text: String,
    val speaker: String,
    val audio: String?,
    val say: String?,
    /** The relative the answer is about ("This is from Maya."), who says hello after it. */
    val personId: String? = null,
)

/** Thrown when the server cannot be used right now, for whatever reason. */
class Offline(message: String) : IOException(message)

/** Thrown when the family has not recorded the wearer's agreement yet. */
class ConsentRequired : IOException("consent_required")

private fun JSONObject.str(key: String) = if (isNull(key)) "" else optString(key, "")

private fun JSONObject.strOrNull(key: String) = if (isNull(key)) null else optString(key).ifBlank { null }

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { getString(it) }

private fun parseAnswer(a: JSONObject) =
    Answer(a.getString("id"), a.str("question"), a.str("text"), a.str("speaker"), a.strOrNull("audio"))

private fun parseKeepsake(o: JSONObject): Keepsake {
  val answers = o.optJSONArray("answers") ?: JSONArray()
  val lane = o.optJSONObject("lane")
  val lens = lane?.optJSONObject("lens")
  return Keepsake(
      id = o.getString("id"),
      name = o.str("name"),
      from = o.str("from"),
      introLine = o.str("introLine"),
      story = o.str("story"),
      memoryPhotos = o.optJSONArray("memoryPhotos").strings(),
      referencePhotos = o.optJSONArray("referencePhotos").strings(),
      voiceNote = o.strOrNull("voiceNote"),
      answers = (0 until answers.length()).map { parseAnswer(answers.getJSONObject(it)) },
      people = o.optJSONArray("people").strings(),
      addedBy = o.strOrNull("addedBy"),
      hasLane = lane != null,
      filmVideo = lens?.strOrNull("video"),
      filmAudio = lens?.strOrNull("audio"),
  )
}

private fun parsePack(o: JSONObject): Pack {
  val profile = o.optJSONObject("profile") ?: JSONObject()
  val keepsakes = o.optJSONArray("keepsakes") ?: JSONArray()
  return Pack(
      version = o.str("version"),
      wearerName = profile.str("wearerName"),
      carerName = profile.str("carerName"),
      wearerAgreed = profile.optJSONObject("consent")?.optBoolean("wearerAgreed") ?: false,
      heartRate = profile.optJSONObject("consent")?.optBoolean("heartRate") ?: false,
      keepsakes = (0 until keepsakes.length()).map { parseKeepsake(keepsakes.getJSONObject(it)) },
      people =
          (o.optJSONArray("people") ?: JSONArray()).let { list ->
            (0 until list.length()).map {
              val p = list.getJSONObject(it)
              val lens = p.optJSONObject("introLens")
              Person(
                  p.getString("id"),
                  p.str("name"),
                  p.str("relationship"),
                  p.str("introText"),
                  p.strOrNull("introAudio"),
                  filmVideo = lens?.strOrNull("video"),
                  filmAudio = lens?.strOrNull("audio"),
                  lane =
                      (p.optJSONObject("lane")?.optJSONArray("clips") ?: JSONArray()).let { clips ->
                        (0 until clips.length()).map { i ->
                          val c = clips.getJSONObject(i)
                          LaneClip(c.optInt("year"), c.str("title"), c.strOrNull("lens"))
                        }
                      },
              )
            }
          },
      answers =
          (o.optJSONArray("answers") ?: JSONArray()).let { list ->
            (0 until list.length()).map { parseAnswer(list.getJSONObject(it)) }
          },
  )
}

/**
 * Talks to the Memory Lane server and keeps an offline copy of everything the wearer might need:
 * the keepsakes, their photos and the family's recordings. Recognition needs the network; playing
 * a memory that is already on the phone does not.
 */
class Repository(context: Context) {
  private val prefs = context.getSharedPreferences("memorylane", Context.MODE_PRIVATE)
  private val packDir = File(context.filesDir, "pack").apply { mkdirs() }
  private val packFile = File(packDir, "pack.json")
  private val queueFile = File(context.filesDir, "events.json")

  var baseUrl: String
    get() = prefs.getString("server", BuildConfig.DEFAULT_SERVER_URL)!!.trimEnd('/')
    set(value) = prefs.edit().putString("server", value.trim().trimEnd('/')).apply()

  /** The household access code from the family app. Not needed over USB (adb reverse). */
  var accessCode: String
    get() = prefs.getString("code", "")!!
    set(value) = prefs.edit().putString("code", value.trim().uppercase()).apply()

  /** Whether the app may listen for the wearer's voice. Off until the family turns it on. */
  var listenForVoice: Boolean
    get() = prefs.getBoolean("listen", false)
    set(value) = prefs.edit().putBoolean("listen", value).apply()

  fun cachedPack(): Pack? =
      runCatching { parsePack(JSONObject(packFile.readText())) }.getOrNull()

  /** Absolute URL for something the server serves. */
  fun url(path: String): String {
    if (path.startsWith("http")) return path
    // Media players fetch by URL and cannot send a header, so the code rides on the query.
    val code = accessCode
    return baseUrl + path + if (code.isBlank()) "" else "?code=" + java.net.URLEncoder.encode(code, "UTF-8")
  }

  /** The on-phone copy of a media file if it has been downloaded, else null. */
  fun localFile(path: String?): File? {
    if (path == null) return null
    val file = File(packDir, path.substringAfterLast('/'))
    return file.takeIf { it.exists() && it.length() > 0 }
  }

  private fun open(path: String, method: String, timeoutMs: Int): HttpURLConnection =
      (URL(baseUrl + path).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 4000
        readTimeout = timeoutMs
        setRequestProperty("Accept", "application/json")
        accessCode.takeIf { it.isNotBlank() }?.let { setRequestProperty("x-memorylane-code", it) }
      }

  private fun request(path: String, body: JSONObject? = null, timeoutMs: Int = 8000): JSONObject {
    val connection =
        try {
          open(path, if (body == null) "GET" else "POST", timeoutMs).also {
            if (body != null) {
              it.doOutput = true
              it.setRequestProperty("Content-Type", "application/json")
              it.outputStream.use { out -> out.write(body.toString().toByteArray()) }
            }
          }
        } catch (e: IOException) {
          throw Offline(e.message ?: "no connection")
        }
    try {
      val code = connection.responseCode
      val text =
          (if (code in 200..299) connection.inputStream else connection.errorStream)
              ?.bufferedReader()
              ?.use { it.readText() }
              .orEmpty()
      if (code == 403 && text.contains("consent_required")) throw ConsentRequired()
      if (code == 401) throw Offline("the access code is missing or wrong")
      if (code !in 200..299) throw Offline("server said $code")
      return JSONObject(text.ifBlank { "{}" })
    } catch (e: ConsentRequired) {
      throw e
    } catch (e: IOException) {
      throw Offline(e.message ?: "no connection")
    } catch (e: org.json.JSONException) {
      throw Offline("unreadable reply")
    } finally {
      connection.disconnect()
    }
  }

  suspend fun health(): JSONObject = withContext(Dispatchers.IO) { request("/api/health", timeoutMs = 4000) }

  /** Downloads the pack and any media the phone does not have yet. Returns the fresh pack. */
  suspend fun syncPack(): Pack =
      withContext(Dispatchers.IO) {
        val json = request("/api/pack")
        val pack = parsePack(json)
        val wanted = mutableSetOf("pack.json")
        val everything =
            pack.keepsakes.flatMap { keepsake ->
              keepsake.memoryPhotos.take(2) +
                  // A lane's sound plays with no connection, and on glasses with no display.
                  listOfNotNull(keepsake.voiceNote, keepsake.filmAudio) +
                  keepsake.answers.mapNotNull { it.audio }
            } + pack.people.flatMap { listOfNotNull(it.introAudio, it.filmAudio) } + pack.answers.mapNotNull { it.audio }
        run {
          for (path in everything) {
            if (path.startsWith("http")) continue
            val name = path.substringAfterLast('/')
            wanted += name
            val target = File(packDir, name)
            if (target.exists() && target.length() > 0) continue
            runCatching { download(path, target) }.onFailure { target.delete() }
          }
        }
        packFile.writeText(json.toString())
        // Anything the family deleted must leave the phone too.
        packDir.listFiles()?.filter { it.name !in wanted }?.forEach { it.delete() }
        pack
      }

  private fun download(path: String, target: File) {
    val connection = URL(url(path)).openConnection() as HttpURLConnection
    connection.connectTimeout = 4000
    connection.readTimeout = 20000
    try {
      if (connection.responseCode !in 200..299) throw IOException("HTTP ${connection.responseCode}")
      val partial = File(target.path + ".part")
      connection.inputStream.use { input -> partial.outputStream().use { input.copyTo(it) } }
      partial.renameTo(target)
    } finally {
      connection.disconnect()
    }
  }

  @Suppress("UNUSED_PARAMETER")
  suspend fun recognise(jpegBase64: String, hint: String?): LookResult =
      withContext(Dispatchers.IO) {
        val body = JSONObject().put("image", jpegBase64)
        if (!hint.isNullOrBlank()) body.put("hint", hint)
        // The server gives the model 12 seconds; allow a little more for the round trip.
        val reply = request("/api/recognise", body, timeoutMs = 16000)
        LookResult(
            reply.strOrNull("matchId"),
            reply.str("objectLabel"),
            reply.optLong("latencyMs"),
        )
      }

  /** [keepsakeId] is null for an everyday question that is not about any object. */
  /** [confidence] is how sure the speech recogniser was of the words (0 to 1), if it said. */
  suspend fun ask(keepsakeId: String?, question: String, confidence: Float? = null): AskResult =
      withContext(Dispatchers.IO) {
        val body = JSONObject().put("question", question)
        if (keepsakeId != null) body.put("keepsakeId", keepsakeId)
        if (confidence != null) body.put("confidence", confidence.toDouble())
        val reply = request("/api/ask", body, timeoutMs = 10000)
        AskResult(
            reply.str("kind"),
            reply.str("text"),
            reply.str("speaker"),
            reply.strOrNull("audio"),
            reply.strOrNull("say"),
            reply.strOrNull("personId"),
        )
      }

  // Events wait on the phone while there is no connection and are sent when it returns.
  @Synchronized
  fun queueEvent(type: String, keepsakeId: String? = null, heart: JSONObject? = null) {
    val queue = runCatching { JSONArray(queueFile.readText()) }.getOrDefault(JSONArray())
    val event = JSONObject().put("type", type).put("at", Instant.now().toString())
    if (keepsakeId != null) event.put("keepsakeId", keepsakeId)
    if (heart != null) event.put("heart", heart)
    queue.put(event)
    queueFile.writeText(queue.toString())
  }

  suspend fun flushEvents() =
      withContext(Dispatchers.IO) {
        val queue =
            synchronized(this@Repository) {
              runCatching { JSONArray(queueFile.readText()) }.getOrDefault(JSONArray())
            }
        if (queue.length() == 0) return@withContext
        request("/api/events", JSONObject().put("events", queue))
        synchronized(this@Repository) { queueFile.delete() }
      }
}

// The same word-overlap match the server uses, so a recorded answer can still be found with no
// connection at all.
private val STOPWORDS =
    "a an the this that these those is are was were am be been do does did i me my mine you your it its of to in on at for with and or but so about please can could would tell say said again"
        .split(" ")
        .toSet()

private fun contentWords(text: String): Set<String> =
    text
        .lowercase()
        .replace("'", "")
        .replace("’", "")
        .replace(Regex("[^a-z0-9\\s]"), " ")
        .split(Regex("\\s+"))
        .filter { it.isNotBlank() && it !in STOPWORDS }
        .map { word ->
          val stem = word.replace(Regex("(ing|ed|es|s)$"), "")
          if (stem == "gave" || stem == "given") "give" else stem
        }
        .toSet()

private fun plainWords(text: String) =
    text.lowercase().replace("'", "").replace("’", "").replace(Regex("[^a-z0-9\\s]"), " ").trim().replace(Regex("\\s+"), " ")

fun matchAnswerOffline(question: String, answers: List<Answer>): Answer? {
  // The same words in the same order is always the same question.
  answers.firstOrNull { plainWords(it.question).isNotEmpty() && plainWords(it.question) == plainWords(question) }?.let { return it }
  val asked = contentWords(question)
  if (asked.isEmpty()) return null
  return answers
      .map { answer ->
        val known = contentWords(answer.question)
        val shared = asked.intersect(known).size.toDouble()
        val score =
            // One word in common is not enough: "Where is Margaret?" is not "Where am I?".
            if (known.isEmpty() || shared < 2) 0.0
            else 0.6 * shared / minOf(asked.size, known.size) + 0.4 * shared / (asked.size + known.size - shared)
        answer to score
      }
      .filter { it.second >= 0.6 }
      .maxByOrNull { it.second }
      ?.first
}
