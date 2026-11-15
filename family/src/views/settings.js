// Settings: who Memory Lane is for, connecting the phone, and deleting. What has been agreed
// lives on the Consent page; this only points there.
import qrcode from "qrcode-generator";
import { api } from "../api.js";
import { clear, confirmDialog, field, formatDate, h, icon, loadInto, statusLine, uid } from "../dom.js";
import { deviceNotifyOn, deviceNotifySupported, refreshHousehold, setDeviceNotify, state } from "../state.js";
import { more } from "../ui.js";

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const size = count + quiet * 2;
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return h(
    "svg",
    { class: "qr", viewBox: `0 0 ${size} ${size}`, role: "img", "aria-label": "QR code that connects the glasses phone to Memory Lane", "shape-rendering": "crispEdges" },
    h("rect", { width: size, height: size, fill: "#ffffff" }),
    h("path", { d, fill: "#000000" }),
  );
}

const section = (title, ...children) => h("section", { class: "section" }, h("h2", null, title), children);

export function settingsView() {
  const formHost = h("div", null);
  const notice = statusLine();

  function renderForm(profile) {
    const consent = profile.consent ?? {};
    const status = statusLine();
    const wearerName = h("input", { type: "text", maxLength: 60, autocomplete: "off", value: profile.wearerName ?? "" });
    const carerName = h("input", { type: "text", maxLength: 60, autocomplete: "off", value: profile.carerName ?? "" });
    const wearer = profile.wearerName || "The wearer";
    const onOff = (on) => (on ? "on" : "off");

    const save = h("button", { type: "submit", class: "btn btn--primary" }, "Save");
    formHost.append(
      h(
        "form",
        {
          novalidate: true,
          onsubmit: async (event) => {
            event.preventDefault();
            if (save.disabled) return;
            save.disabled = true;
            status.set("Saving…");
            try {
              await api.saveProfile({ wearerName: wearerName.value, carerName: carerName.value }, state.me?.id);
              await refreshHousehold();
              status.ok("Saved.");
            } catch (error) {
              status.error(error.message);
            } finally {
              save.disabled = false;
            }
          },
          oninput: () => status.set("Not saved yet."),
        },
        h(
          "section",
          { class: "stack" },
          h("h2", null, "The wearer"),
          field({ label: "Name", hint: "What you call them: “Mum”, “Grandad”.", control: wearerName }),
          field({ label: "Main carer", control: carerName, optional: true }),
          h("div", { class: "row" }, save, status.el),
        ),
      ),
      section(
        "Privacy",
        h(
          "a",
          { class: `next-step ${consent.wearerAgreed ? "" : "card--warn"}`.trim(), href: "#/consent" },
          h("span", { class: "badge-icon", "aria-hidden": "true" }, icon("shield", 24)),
          h(
            "span",
            null,
            h("span", { style: "display:block" }, consent.wearerAgreed ? `${wearer} agreed${consent.agreedAt ? ` · ${formatDate(consent.agreedAt, { day: "numeric", month: "short" })}` : ""}` : "Glasses off: not agreed yet"),
            h("span", { class: "muted small", style: "font-weight:400" }, `Questions ${onOff(consent.careSignals)} · New things ${onOff(consent.logUnknownObjects)} · Heart rate ${onOff(consent.heartRate)}`),
          ),
          icon("right", 22),
        ),
      ),
    );
  }
  loadInto(formHost, api.profile, renderForm);

  // ---- Notifications on this device --------------------------------------------------------
  const deviceNote = h("p", { class: "field__hint" });
  const deviceSwitch = h("input", { type: "checkbox", role: "switch", class: "switch__input", id: uid("switch"), checked: deviceNotifyOn(), disabled: !deviceNotifySupported() });
  const describeDevice = (problem) => {
    deviceNote.textContent = problem ?? (!deviceNotifySupported() ? "This browser can't show alerts." : "");
    deviceNote.hidden = !deviceNote.textContent;
  };
  deviceSwitch.addEventListener("change", async () => {
    const problem = await setDeviceNotify(deviceSwitch.checked);
    if (problem) deviceSwitch.checked = false;
    describeDevice(problem);
  });
  describeDevice();

  // ---- Connect the phone -------------------------------------------------------------------
  const pairStatus = statusLine();
  const pairing = more("Show QR code", () => {
    const body = h("div", { class: "stack" }, h("p", { class: "loading" }, "Loading…"));
    const show = (data) => {
      clear(body).append(
        data.link ? qrSvg(data.link) : h("p", { class: "status status--error" }, "Can't reach the phone. Use the same Wi-Fi, or a USB cable."),
        h(
          "dl",
          { class: "facts" },
          h("dt", null, "Family code"),
          h("dd", { class: "mono code", "aria-label": data.code.split("").join(" ") }, `${data.code.slice(0, 4)} ${data.code.slice(4)}`),
          h("dt", null, "Web address"),
          h("dd", { class: "mono" }, data.urls[0] ?? "Not on Wi-Fi"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "link link--quiet small",
            onclick: async () => {
              const agreed = await confirmDialog({ title: "Make a new family code?", body: "Every other device, the glasses phone too, will need the new code.", confirmLabel: "New code", cancelLabel: "Keep this one" });
              if (!agreed) return;
              try {
                show(await api.newCode());
                pairStatus.ok("New code made.");
              } catch (error) {
                pairStatus.error(error.message);
              }
            },
          },
          "New code",
        ),
      );
    };
    api.pairing().then(show).catch((error) => clear(body).append(h("p", { class: "status status--error" }, error.message)));
    return body;
  });

  // ---- Status, one line ----------------------------------------------------------------------
  const statusText = h("p", { class: "muted small" }, "Checking…");
  api
    .health()
    .then((health) => {
      const sees = health.recogniser === "gemini";
      clear(statusText).append(
        h("span", { class: "dot dot--on", "aria-hidden": "true" }),
        sees ? "Working" : "Working, in practice mode",
      );
    })
    .catch(() => (statusText.textContent = "Can't connect."));

  return h(
    "div",
    { class: "page" },
    h("h1", { tabindex: "-1" }, "Settings"),
    notice.el,
    formHost,
    section(
      "Alerts",
      h("div", { class: "group" }, h("div", { class: "switch row-link" }, h("div", { class: "switch__text" }, h("label", { class: "switch__label", for: deviceSwitch.id }, "Alerts on this device"), deviceNote), deviceSwitch)),
    ),
    section(
      "Connect the glasses",
      h("p", { class: "muted" }, "Scan with the glasses phone's camera."),
      pairing,
      pairStatus.el,
    ),
    section(
      "Data",
      more("How your data is kept", () =>
        h(
          "ul",
          { class: "stack" },
          [
            "Camera pictures are never kept.",
            "No voice is ever copied.",
            "Every answer comes from the family.",
            "You can delete anything.",
          ].map((line) => h("li", null, line)),
        ),
      ),
      h(
        "p",
        null,
        h(
          "button",
          {
            type: "button",
            class: "link link--danger",
            onclick: async () => {
              const agreed = await confirmDialog({
                title: "Delete the history?",
                body: "Memories opened, questions asked and notifications go. Memories, answers and family stay.",
                confirmLabel: "Delete",
              });
              if (!agreed) return;
              try {
                await api.clearEvents();
                notice.ok("History deleted.");
                window.scrollTo(0, 0);
              } catch (error) {
                notice.error(error.message);
              }
            },
          },
          "Delete history",
        ),
      ),
    ),
    h("div", { class: "section" }, statusText),
  );
}
