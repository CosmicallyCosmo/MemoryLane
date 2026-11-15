// A person's profile: their photo, their hello, and the memories they have shared.
// Each person looks after their own.
import { api } from "../api.js";
import { audioField } from "../components.js";
import { avatar, confirmDialog, h, icon, loadInto, modal, statusLine, uid } from "../dom.js";
import { downscalePhoto } from "../media.js";
import { loadMembers, setMe, state } from "../state.js";
import { canMakeLensCopy, makeLensCopy } from "../lane/lens.js";
import { more } from "../ui.js";
import { memberForm } from "./family.js";
import { memoryTile } from "./memories.js";


/** A hello as a film for the glasses: the person's video, with their recording as its sound. */
const helloFilm = (member) => ({
  id: member.id,
  name: member.name,
  music: "none",
  ambience: "none",
  pace: "gentle",
  segments: [
    {
      keepsakeId: member.id,
      name: member.name,
      from: "",
      voice: member.introAudio,
      words: member.introText ?? "",
      shots: [{ src: member.introVideo, kind: "video", at: 0, focus: [0.5, 0.45], motion: "still" }],
    },
  ],
});

function laneSection(member, { canEdit, isMe, first, refresh }) {
  const count = member.lane?.count ?? 0;
  const whose = isMe ? "Your" : `${first}'s`;
  const section = h("section", { class: "section card card--grey" }, h("h2", { class: "card__title" }, `${whose} memory lane`));
  const list = h("div", { class: "stack" });
  const status = statusLine();
  const page = `/lane/${encodeURIComponent(member.id)}/memory-lane.html`;

  section.append(
    h(
      "p",
      { class: "muted" },
      count
        ? `${count} ${count === 1 ? "moment" : "moments"}, walked through in order of year. The glasses offer it after saying who ${isMe ? "you are" : `${first} is`}.`
        : "Short videos from a life, walked through one year after another. The glasses offer it after saying who this is.",
    ),
  );
  if (count) {
    section.append(h("div", { class: "row" }, h("a", { class: "btn btn--primary", href: page, target: "_blank", rel: "noopener" }, icon("play", 22), "Walk down memory lane")));
  }
  if (!canEdit) return section;

  // The moments already there, each with a way to take it out.
  const renderList = (lane) => {
    list.replaceChildren(
      ...lane.memories.map((moment) =>
        h(
          "div",
          { class: "row" },
          h("span", null, h("strong", null, String(moment.year)), ` · ${moment.title}`),
          h(
            "button",
            {
              type: "button",
              class: "link link--danger small",
              onclick: async () => {
                if (!(await confirmDialog({ title: `Remove “${moment.title}”?`, body: "It comes out of the memory lane.", confirmLabel: "Remove", cancelLabel: "Keep it" }))) return;
                try {
                  await api.removeLaneClip(member.id, moment.id);
                  refresh();
                } catch (error) {
                  status.error(error.message);
                }
              },
            },
            "Remove",
          ),
        ),
      ),
    );
  };
  if (count) api.personLane(member.id).then(renderList, (error) => status.error(error.message));

  const year = h("input", { type: "number", inputmode: "numeric", min: 1900, max: new Date().getFullYear() + 1, placeholder: "Year", "aria-label": "The year it was", required: true });
  const title = h("input", { type: "text", maxLength: 60, placeholder: "What the moment was, e.g. First day of school", "aria-label": "What the moment was", required: true });
  // A button that opens the file chooser, naming the video once one is chosen.
  const videoName = h("span", null, "Choose the video");
  const video = h("input", {
    type: "file",
    accept: "video/mp4,video/webm,video/quicktime,video/*",
    class: "visually-hidden",
    id: uid("moment"),
    "aria-label": "The video",
    required: true,
    onchange: () => (videoName.textContent = video.files?.[0]?.name ?? "Choose the video"),
  });
  const videoPicker = h("div", null, h("label", { class: "btn", for: video.id }, icon("film", 22), videoName), video);
  const progress = h("progress", { max: 1, value: 0, class: "progress", hidden: true, "aria-label": "Upload progress" });
  const add = h("button", { type: "submit", class: "btn btn--block" }, icon("plus", 22), count ? "Add this moment" : "Start the memory lane");
  const form = h(
    "form",
    {
      class: "form",
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (add.disabled) return;
        const chosen = video.files?.[0];
        if (!chosen) return status.error("Please choose a video.");
        if (!year.value) return status.error("Please add the year it was.");
        if (!title.value.trim()) return status.error("Please say what the moment was.");
        add.disabled = true;
        progress.hidden = false;
        status.set("Adding it. Please keep this page open until it's done.");
        try {
          await api.addLaneClip(member.id, { video: chosen, year: year.value, title: title.value.trim() }, (f) => (progress.value = f));
          refresh();
        } catch (error) {
          add.disabled = false;
          progress.hidden = true;
          status.error(error.message);
        }
      },
    },
    h("h3", null, count ? "Add a moment" : "Add the first moment"),
    year,
    title,
    videoPicker,
    progress,
    status.el,
    add,
  );
  section.append(list, form);
  return section;
}

export function profileView({ id, onCleanup, rerender }) {
  const host = h("div", { class: "stack" });
  const notice = statusLine();

  loadInto(
    host,
    () => Promise.all([loadMembers(), api.keepsakes()]),
    ([members, memories]) => {
      const member = members.find((m) => m.id === id);
      if (!member) {
        host.append(h("h1", { tabindex: "-1" }, "Not in the family any more"), h("a", { class: "btn btn--primary", href: "#/family" }, "Back to Family"));
        return;
      }
      const isMe = member.id === state.me?.id;
      const iOrganise = state.me?.role === "organiser";
      const first = member.name.split(/\s+/)[0];
      document.title = `${member.name} · Memory Lane`;
      const refresh = async () => {
        await loadMembers();
        rerender();
      };

      // ---- Who they are ------------------------------------------------------------------
      const photoInput = h("input", {
        type: "file",
        accept: "image/jpeg,image/png,image/webp,image/*",
        class: "visually-hidden",
        id: uid("photo"),
        onchange: async () => {
          const chosen = photoInput.files?.[0];
          photoInput.value = "";
          if (!chosen) return;
          notice.set("Adding photo…");
          try {
            await api.saveMemberProfile(member.id, { photo: await downscalePhoto(chosen) });
            refresh();
          } catch (error) {
            notice.error(error.message);
          }
        },
      });
      const fact = (n, one, many) => h("div", { class: "fact" }, h("strong", null, String(n ?? 0)), h("span", null, n === 1 ? one : many));
      host.append(
        h(
          "div",
          { class: "profile-head" },
          avatar(member, "hero"),
          h("h1", { tabindex: "-1" }, member.name),
          h("p", { class: "lede" }, member.relationship || "Family"),
          isMe ? h("button", { type: "button", class: "btn", onclick: () => photoInput.click() }, icon("camera", 22), member.photo ? "Change photo" : "Add photo") : null,
          isMe ? photoInput : null,
        ),
        h(
          "div",
          { class: "facts-row" },
          fact(member.keepsakesAdded, "memory", "memories"),
          fact(member.answersRecorded, "answer", "answers"),
          fact(member.timesHeard, "time heard", "times heard"),
        ),
        notice.el,
      );

      // ---- Hello ---------------------------------------------------------------------------
      const hello = h("section", { class: "section card card--grey" }, h("h2", { class: "card__title" }, isMe ? "Your hello" : `${first}'s hello`));
      const sample = `“Hello, it's ${first}${member.relationship ? `, your ${member.relationship.toLowerCase()}` : ""}. It's lovely to see you.”`;
      if (isMe) {
        const status = statusLine();
        const text = h("textarea", { rows: 2, maxLength: 300, "aria-label": "Your hello, in words", placeholder: member.relationship ? `It's ${first}, your ${member.relationship.toLowerCase()}.` : `It's ${first}.` });
        text.value = member.introText ?? "";
        const audio = audioField({ legend: member.introAudio ? "Record a new one" : "Record it", hint: sample, baseName: "hello", optional: false });
        onCleanup(() => audio.destroy());
        const save = h("button", { type: "submit", class: "btn btn--primary btn--block" }, "Save");

        // A short video of yourself to go with the hello, and the copy of both for the glasses.
        const videoStatus = statusLine();
        const videoInput = h("input", {
          type: "file",
          accept: "video/mp4,video/webm,video/quicktime,video/*",
          class: "visually-hidden",
          id: uid("hello-video"),
          onchange: async () => {
            const chosen = videoInput.files?.[0];
            videoInput.value = "";
            if (!chosen) return;
            videoStatus.set("Adding your video…");
            try {
              await api.saveMemberProfile(member.id, { introVideo: chosen });
              refresh();
            } catch (error) {
              videoStatus.error(error.message);
            }
          },
        });
        const progress = h("progress", { max: 1, value: 0, class: "progress", hidden: true, "aria-label": "Glasses copy progress" });
        const lensLabel = member.introLens ? "Make the glasses copy again" : "Put it on the glasses";
        const lensButton = h("button", { type: "button", class: "btn" }, lensLabel);
        let lensAbort = null;
        onCleanup(() => lensAbort?.abort());
        // With Cloudinary the server makes the copy; look again until it has.
        if (member.introLensMaking) {
          const again = setTimeout(refresh, 3000);
          onCleanup(() => clearTimeout(again));
        }
        lensButton.addEventListener("click", async () => {
          if (lensAbort) return lensAbort.abort();
          const abort = new AbortController();
          lensAbort = abort;
          lensButton.textContent = "Stop";
          progress.hidden = false;
          progress.value = 0;
          videoStatus.set("Getting it ready for the glasses. Please keep this page open until it's done.");
          try {
            const copy = await makeLensCopy(helloFilm(member), { signal: abort.signal, onProgress: (f) => (progress.value = f) });
            await api.saveMemberProfile(member.id, { lensVideo: copy.video, lensAudio: copy.audio });
            lensAbort = null;
            refresh();
          } catch (error) {
            lensAbort = null;
            progress.hidden = true;
            lensButton.textContent = lensLabel;
            if (abort.signal.aborted) videoStatus.clear();
            else videoStatus.error(error.message);
          }
        });
        const helloVideo = h(
          "div",
          { class: "stack card__part" },
          h("h3", null, "A video to go with it"),
          member.introVideo
            ? h("video", { controls: true, muted: true, controlsList: "nodownload noplaybackrate", preload: "metadata", playsinline: true, src: member.introVideo, poster: member.introPoster || undefined, class: "hello-video", "aria-label": "The video with your hello" })
            : h("p", { class: "muted" }, "A few seconds of you, or of the two of you together. Glasses with a screen show it with your hello."),
          h(
            "div",
            { class: "row" },
            h("button", { type: "button", class: "link", onclick: () => videoInput.click() }, member.introVideo ? "Choose a different video" : "Add a video"),
            videoInput,
            member.introVideo
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "link link--danger small",
                    onclick: async () => {
                      if (!(await confirmDialog({ title: "Remove your video?", body: "Your hello will be heard on its own.", confirmLabel: "Remove video", cancelLabel: "Keep it" }))) return;
                      try {
                        await api.saveMemberProfile(member.id, { removeIntroVideo: true });
                        refresh();
                      } catch (error) {
                        videoStatus.error(error.message);
                      }
                    },
                  },
                  "Remove video",
                )
              : null,
          ),
          member.introVideo && member.introAudio
            ? h(
                "p",
                null,
                member.introLens
                  ? member.introLensByServer
                    ? "It's on the glasses: they show the video, cropped around you by Cloudinary, while your recording plays."
                    : "It's on the glasses: they show the video while your recording plays."
                  : member.introLensMaking
                    ? "Being made for the glasses now. You can close this page: it's made on the server."
                    : "It isn't on the glasses yet. Until it is, the glasses play your recording on its own.",
              )
            : member.introVideo
              ? h("p", { class: "muted" }, "Record your hello as well, and the two can go on the glasses together.")
              : null,
          member.introVideo && member.introAudio && !member.introLensByServer && canMakeLensCopy() ? h("div", { class: "row" }, lensButton) : null,
          member.introVideo && member.introAudio && member.introLensByServer && !member.introLensMaking
            ? h(
                "div",
                { class: "row" },
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn",
                    onclick: async () => {
                      try {
                        await api.makeHelloLens(member.id);
                        refresh();
                      } catch (error) {
                        videoStatus.error(error.message);
                      }
                    },
                  },
                  member.introLens ? "Make the glasses copy again" : "Put it on the glasses",
                ),
              )
            : null,
          progress,
          videoStatus.el,
        );
        hello.append(
          ...[
          h("p", { class: "muted" }, "Plays when they ask “who is that?”"),
          member.introAudio
            ? h(
                "div",
                { class: "row" },
                h("audio", { controls: true, preload: "none", src: member.introAudio, class: "audio-player", "aria-label": "Your recorded hello" }),
                h(
                  "button",
                  {
                    type: "button",
                    class: "link link--danger small",
                    onclick: async () => {
                      if (!(await confirmDialog({ title: "Remove your recording?", body: "Your written line is read out instead.", confirmLabel: "Remove", cancelLabel: "Keep it" }))) return;
                      try {
                        await api.saveMemberProfile(member.id, { removeIntroAudio: true });
                        refresh();
                      } catch (error) {
                        status.error(error.message);
                      }
                    },
                  },
                  "Remove",
                ),
              )
            : null,
          h(
            "form",
            {
              class: "form",
              novalidate: true,
              onsubmit: async (event) => {
                event.preventDefault();
                if (save.disabled) return;
                if (audio.isRecording()) return status.error("Stop recording first.");
                save.disabled = true;
                status.set("Saving…");
                try {
                  await api.saveMemberProfile(member.id, { introText: text.value.trim(), introAudio: audio.getFile() ?? undefined });
                  audio.destroy();
                  refresh();
                } catch (error) {
                  save.disabled = false;
                  status.error(error.message);
                }
              },
            },
            audio.el,
            text,
            status.el,
            save,
          ),
          helloVideo,
          ].filter(Boolean),
        );
      } else {
        hello.append(
          ...[
          member.introAudio ? h("audio", { controls: true, preload: "none", src: member.introAudio, class: "audio-player", "aria-label": `${first}'s recorded hello` }) : null,
          member.introText ? h("p", { class: "quote" }, `“${member.introText}”`) : null,
          member.introVideo ? h("video", { controls: true, muted: true, controlsList: "nodownload noplaybackrate", preload: "metadata", playsinline: true, src: member.introVideo, class: "hello-video", "aria-label": `The video with ${first}'s hello` }) : null,
          !member.introAudio && !member.introText ? h("p", { class: "muted" }, "Not recorded yet.") : null,
          ].filter(Boolean),
        );
      }
      host.append(hello);

      // ---- Memory lane ---------------------------------------------------------------------
      // Clips from this person's life, in order of year. The glasses offer it after saying who
      // they are; the person themselves, or an organiser, adds to it.
      host.append(laneSection(member, { canEdit: isMe || iOrganise, isMe, first, refresh }));

      // ---- Their memories -----------------------------------------------------------------
      const theirs = memories.filter((k) => k.addedBy === member.id || (k.people ?? []).includes(member.id));
      host.append(
        h(
          "section",
          { class: "section" },
          h(
            "div",
            { class: "section__head" },
            h("h2", null, isMe ? "Your memories" : `${first}'s memories`),
            isMe ? h("a", { class: "icon-btn icon-btn--filled", href: "#/memories?add=1", "aria-label": "Add a memory" }, icon("plus", 24)) : null,
          ),
          theirs.length ? h("ul", { class: "grid" }, theirs.map((k) => memoryTile(k))) : h("p", { class: "muted" }, "None yet."),
        ),
      );

      // ---- Edit: name, role, remove -------------------------------------------------------
      if (isMe || iOrganise) {
        const act = async (fn) => {
          try {
            await fn();
            refresh();
          } catch (error) {
            // The server explains why, for example when the last organiser tries to step down.
            notice.error(error.message);
            notice.el.scrollIntoView({ block: "center" });
          }
        };
        host.append(
          h(
            "div",
            { class: "section" },
            more(
              isMe ? "Edit your details" : `Edit ${first}'s details`,
              () => [
                h(
                  "div",
                  { class: "row" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "link",
                      onclick: async () => {
                        const saved = await modal({ title: "Edit details", build: (close) => memberForm({ member, onDone: close }) });
                        if (saved) refresh();
                      },
                    },
                    "Name and relationship",
                  ),
                ),
                iOrganise
                  ? h(
                      "div",
                      { class: "row" },
                      h(
                        "button",
                        { type: "button", class: "link", onclick: () => act(() => api.updateMember(member.id, { role: member.role === "organiser" ? "contributor" : "organiser" })) },
                        member.role === "organiser" ? "Remove as organiser" : "Make organiser",
                      ),
                      member.role === "organiser" ? h("span", { class: "pill pill--on" }, "Organiser") : null,
                    )
                  : null,
                h(
                  "div",
                  { class: "row" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "link link--danger",
                      onclick: async () => {
                        const agreed2 = await confirmDialog({
                          title: isMe ? "Leave the family here?" : `Remove ${member.name}?`,
                          body: `${isMe ? "Your" : "Their"} photo and hello go. Memories and answers stay.`,
                          confirmLabel: isMe ? "Leave" : "Remove",
                          cancelLabel: isMe ? "Stay" : "Keep them",
                        });
                        if (!agreed2) return;
                        act(async () => {
                          await api.removeMember(member.id);
                          if (isMe) setMe(null);
                          window.location.hash = "#/family";
                        });
                      },
                    },
                    isMe ? "Leave the family" : `Remove ${first}`,
                  ),
                ),
              ],
              { quiet: true },
            ),
          ),
        );
      }
    },
  );

  return h("div", { class: "page" }, host);
}
