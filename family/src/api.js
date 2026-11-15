// Every call the family app makes to the Memory Lane server. Same-origin, relative URLs.

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const OFFLINE = "We can't reach Memory Lane just now. Please check this device is connected to the internet or Wi-Fi, and try again.";

/** Fired when the server wants the family code. main.js shows the form that asks for it. */
export const CODE_REQUIRED_EVENT = "memorylane:code-required";

function codeRequired(status, body) {
  if (status !== 401 || body?.error !== "code_required") return false;
  window.dispatchEvent(new Event(CODE_REQUIRED_EVENT));
  return true;
}

function messageFor(status, body) {
  if (status === 401 && body?.error === "code_required") return "Please type the family code to carry on.";
  if (status === 404) return "We couldn't find that. Someone may already have removed it.";
  if (body && typeof body.error === "string" && body.error) return body.error;
  if (status === 413) return "That file is a little too big. Please try a shorter recording or video.";
  return "Sorry, something went wrong on our side. Please try again in a moment.";
}

async function request(method, url, body) {
  const options = { method, headers: { Accept: "application/json" } };
  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new ApiError(OFFLINE);
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    // Signing in reports a wrong code itself; everywhere else a 401 means "ask for the code".
    if (url !== "/api/session") codeRequired(response.status, data);
    throw new ApiError(messageFor(response.status, data), response.status);
  }
  return data;
}

// Multipart upload with progress, which fetch cannot report.
function upload(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "text";
    xhr.setRequestHeader("Accept", "application/json");
    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      });
    }
    xhr.addEventListener("load", () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      codeRequired(xhr.status, data);
      reject(new ApiError(messageFor(xhr.status, data), xhr.status));
    });
    xhr.addEventListener("error", () => reject(new ApiError(OFFLINE)));
    xhr.addEventListener("abort", () => reject(new ApiError("Sending was stopped before it finished. Please try again.")));
    xhr.send(form);
  });
}

export const api = {
  health: () => request("GET", "/api/health"),

  /** Exchanges the household code for a session cookie. Rejects with status 401 if it is wrong. */
  signIn: (code) => request("POST", "/api/session", { code }),
  /** @returns {Promise<{code: string, urls: string[], link: string|null}>} */
  pairing: () => request("GET", "/api/pairing"),
  newCode: () => request("POST", "/api/pairing/rotate"),

  profile: () => request("GET", "/api/profile"),
  /** `changedBy` is the member making the change, so the consent history can say who. */
  saveProfile: (patch, changedBy) => request("PUT", "/api/profile", { ...patch, changedBy }),
  /** Everything agreed, by whom and when, and the history of changes. */
  consent: () => request("GET", "/api/consent"),

  keepsakes: () => request("GET", "/api/keepsakes"),

  /**
   * @param {{name:string, description:string, from:string, introLine:string, story:string,
   *   referencePhotos:File[], memoryPhotos:File[], voiceNote:File, clip:File|null,
   *   consentConfirmed:boolean}} keepsake
   * With photos or a video it is answered once its lane is planned, which can take a minute.
   */
  createKeepsake(keepsake, onProgress) {
    const form = new FormData();
    form.append("name", keepsake.name);
    form.append("description", keepsake.description);
    form.append("from", keepsake.from);
    form.append("introLine", keepsake.introLine);
    form.append("story", keepsake.story);
    form.append("consentConfirmed", keepsake.consentConfirmed ? "true" : "false");
    if (keepsake.addedBy) form.append("addedBy", keepsake.addedBy);
    if (keepsake.people?.length) form.append("people", keepsake.people.join(","));
    for (const photo of keepsake.referencePhotos) form.append("referencePhotos", photo, photo.name);
    for (const photo of keepsake.memoryPhotos) form.append("memoryPhotos", photo, photo.name);
    if (keepsake.voiceNote) form.append("voiceNote", keepsake.voiceNote, keepsake.voiceNote.name);
    if (keepsake.clip) form.append("clip", keepsake.clip, keepsake.clip.name);
    return upload("/api/keepsakes", form, onProgress);
  },

  updateKeepsake: (id, patch) => request("PATCH", `/api/keepsakes/${encodeURIComponent(id)}`, patch),
  /** More photos of the object, such as a close-up of a mark only this one has. */
  addKeepsakePhotos(id, photos, onProgress) {
    const form = new FormData();
    for (const photo of photos) form.append("referencePhotos", photo, photo.name);
    return upload(`/api/keepsakes/${encodeURIComponent(id)}/photos`, form, onProgress);
  },
  deleteKeepsake: (id) => request("DELETE", `/api/keepsakes/${encodeURIComponent(id)}`),
  /** What the memory's voice message says, written down for the family to check. Not saved. */
  transcribeVoice: (id) => request("POST", `/api/keepsakes/${encodeURIComponent(id)}/transcript`),

  /** @param {{question:string, text:string, speaker:string, audio:File|null}} answer */
  addAnswer(keepsakeId, answer) {
    const form = new FormData();
    form.append("question", answer.question);
    form.append("text", answer.text);
    form.append("speaker", answer.speaker);
    if (answer.addedBy) form.append("addedBy", answer.addedBy);
    if (answer.audio) form.append("audio", answer.audio, answer.audio.name);
    return request("POST", `/api/keepsakes/${encodeURIComponent(keepsakeId)}/answers`, form);
  },

  deleteAnswer: (keepsakeId, answerId) =>
    request(
      "DELETE",
      `/api/keepsakes/${encodeURIComponent(keepsakeId)}/answers/${encodeURIComponent(answerId)}`,
    ),

  summary: (days = 7) => request("GET", `/api/summary?days=${days}`),
  stats: (days = 7) => request("GET", `/api/stats?days=${days}`),
  activity: (limit = 60) => request("GET", `/api/activity?limit=${limit}`),
  /** What the wearer did with one memory, newest first. */
  memoryHeart: (id) => request("GET", `/api/keepsakes/${encodeURIComponent(id)}/heart`),
  memoryActivity: (id, limit = 12) => request("GET", `/api/activity?limit=${limit}&keepsake=${encodeURIComponent(id)}`),

  members: () => request("GET", "/api/members"),
  addMember: (member) => request("POST", "/api/members", member),
  updateMember: (id, patch) => request("PATCH", `/api/members/${encodeURIComponent(id)}`, patch),
  removeMember: (id) => request("DELETE", `/api/members/${encodeURIComponent(id)}`),

  // A person's memory lane: clips from their life, walked through in order of year.
  personLane: (id) => request("GET", `/api/members/${encodeURIComponent(id)}/lane`),
  /** @param {{video:File, year:number|string, title:string}} moment */
  addLaneClip(id, { video, year, title }, onProgress) {
    const form = new FormData();
    form.append("video", video, video.name);
    form.append("year", String(year));
    form.append("title", title);
    return upload(`/api/members/${encodeURIComponent(id)}/lane`, form, onProgress);
  },
  removeLaneClip: (id, clipId) => request("DELETE", `/api/members/${encodeURIComponent(id)}/lane/${encodeURIComponent(clipId)}`),

  /**
   * A person's own profile: their photo, and their "hello".
   * @param {{photo?:File, introAudio?:File, introText?:string, removeIntroAudio?:boolean,
   *   introVideo?:File, removeIntroVideo?:boolean, lensVideo?:File, lensAudio?:File}} profile
   *   `lensVideo` and `lensAudio`: the hello's glasses copy, made from the recording and video.
   */
  saveMemberProfile(id, profile) {
    const form = new FormData();
    if (profile.photo) form.append("photo", profile.photo, profile.photo.name);
    if (profile.introAudio) form.append("introAudio", profile.introAudio, profile.introAudio.name);
    if (typeof profile.introText === "string") form.append("introText", profile.introText);
    if (profile.removeIntroAudio) form.append("removeIntroAudio", "true");
    if (profile.introVideo) form.append("introVideo", profile.introVideo, profile.introVideo.name);
    if (profile.removeIntroVideo) form.append("removeIntroVideo", "true");
    if (profile.lensVideo && profile.lensAudio) {
      form.append("lensVideo", profile.lensVideo, profile.lensVideo.name);
      form.append("lensAudio", profile.lensAudio, profile.lensAudio.name);
    }
    return request("POST", `/api/members/${encodeURIComponent(id)}/profile`, form);
  },

  /** Questions waiting for an answer, and the everyday answers already recorded. */
  questions: () => request("GET", "/api/questions"),
  /** @param {{question:string, text:string, speaker:string, audio:File|null, addedBy?:string}} answer */
  addQuestionAnswer(answer) {
    const form = new FormData();
    form.append("question", answer.question);
    form.append("text", answer.text);
    form.append("speaker", answer.speaker);
    if (answer.addedBy) form.append("addedBy", answer.addedBy);
    if (answer.audio) form.append("audio", answer.audio, answer.audio.name);
    return request("POST", "/api/questions", form);
  },
  deleteQuestionAnswer: (id) => request("DELETE", `/api/questions/${encodeURIComponent(id)}`),

  notifications: (member) => request("GET", `/api/notifications?member=${encodeURIComponent(member ?? "")}`),
  markRead: (member, ids) =>
    request("POST", "/api/notifications/read", ids ? { member, ids } : { member, all: true }),
  requestAnswer: (request_) => request("POST", "/api/notifications/request", request_),

  clearEvents: () => request("DELETE", "/api/events"),

  // A memory's lane, by the memory's id. A change in words can take a minute: the model
  // listens to the voice message again.
  lane: (id) => request("GET", `/api/keepsakes/${encodeURIComponent(id)}/lane`),
  reviseLane: (id, words) => request("POST", `/api/keepsakes/${encodeURIComponent(id)}/lane/revise`, { request: words }),
  /** @param {{music?:string, ambience?:string, pace?:string}} patch */
  updateLane: (id, patch) => request("PATCH", `/api/keepsakes/${encodeURIComponent(id)}/lane`, patch),
  undoLane: (id) => request("POST", `/api/keepsakes/${encodeURIComponent(id)}/lane/undo`),
  /** The glasses copy: the small silent video and its sound, made from plan `version`. */
  uploadLaneLens(id, { video, audio, version }, onProgress) {
    const form = new FormData();
    form.append("version", String(version));
    form.append("video", video, video.name);
    form.append("audio", audio, audio.name);
    return upload(`/api/keepsakes/${encodeURIComponent(id)}/lane/lens`, form, onProgress);
  },
};
