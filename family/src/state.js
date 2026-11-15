// What the whole app shares: who is using this browser, and their notices.
import { api } from "./api.js";
import { toast } from "./dom.js";
import { stillWaiting } from "./match.js";

const ME_KEY = "memorylane.me";
const RANGE_KEY = "memorylane.range";
const DEVICE_NOTIFY_KEY = "memorylane.deviceNotify";
const POLL_MS = 15000;

const read = (key) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const write = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private windows may refuse; these are conveniences only.
  }
};

const listeners = new Set();
export const state = {
  /** @type {{id:string,name:string,relationship:string,role:string}|null} */
  me: null,
  members: [],
  unread: 0,
  notifications: [],
  /** Questions the wearer has asked that nobody has answered yet. */
  openQuestions: 0,
  /** Who wears the glasses, and whether they have agreed. Until known, assume all is well. */
  wearerName: "",
  wearerAgreed: true,
};

export const onChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn(state));

export async function loadMembers() {
  state.members = await api.members();
  const id = read(ME_KEY);
  state.me = state.members.find((m) => m.id === id) ?? null;
  if (!state.me) write(ME_KEY, "");
  emit();
  return state.members;
}

/** Keeps the wearer's name and agreement current, for the banner shown while the glasses are off. */
export async function refreshHousehold() {
  try {
    const profile = await api.profile();
    const agreed = Boolean(profile.consent?.wearerAgreed);
    if (agreed !== state.wearerAgreed || profile.wearerName !== state.wearerName) {
      state.wearerAgreed = agreed;
      state.wearerName = profile.wearerName ?? "";
      emit();
    }
  } catch {
    // Keep what we had; the next poll will try again.
  }
}

export function setMe(member) {
  state.me = member;
  write(ME_KEY, member?.id ?? "");
  seen.clear();
  primed = false;
  emit();
  refreshNotifications();
}

export const getRange = () => Number(read(RANGE_KEY)) || 7;
export const setRange = (days) => write(RANGE_KEY, String(days));

// ---- Notifications -----------------------------------------------------------------------

const seen = new Set();
let primed = false;
let timer = 0;

export const deviceNotifySupported = () => "Notification" in window;
export const deviceNotifyOn = () =>
  deviceNotifySupported() && Notification.permission === "granted" && read(DEVICE_NOTIFY_KEY) === "on";

/** Turns device notifications on or off. Resolves to a sentence if it could not be turned on. */
export async function setDeviceNotify(on) {
  if (!on) {
    write(DEVICE_NOTIFY_KEY, "");
    return null;
  }
  if (!deviceNotifySupported()) return "Sorry, this browser can't show alerts.";
  let permission = Notification.permission;
  // Only asked for here, when the switch is turned on by hand.
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return "Alerts are blocked for Memory Lane in this browser's settings. Allow notifications for this site there, then try again.";
  }
  write(DEVICE_NOTIFY_KEY, "on");
  return null;
}

export async function refreshNotifications() {
  if (!state.me) return;
  let data;
  try {
    data = await api.notifications(state.me.id);
  } catch {
    return; // The next poll will try again; a missed poll is not worth a message.
  }
  const fresh = data.notifications.filter((n) => !n.read && !seen.has(n.id));
  data.notifications.forEach((n) => seen.add(n.id));
  // The first load after opening the app is history, not news.
  if (primed) {
    for (const notice of fresh.slice(0, 3)) {
      toast(notice.title, notice.body, { href: "#/notifications" });
      if (deviceNotifyOn() && document.hidden) {
        try {
          new Notification(notice.title, { body: notice.body, tag: notice.id });
        } catch {
          // Some browsers only allow this from a service worker. The in-page notice still shows.
        }
      }
    }
  }
  primed = true;
  state.unread = data.unread;
  state.notifications = data.notifications;
  emit();
  refreshOpenQuestions();
  refreshHousehold();
}

/** Keeps the count beside "Questions" current. A page that changes it calls this too. */
export async function refreshOpenQuestions() {
  try {
    const [questions, memories] = await Promise.all([api.questions(), api.keepsakes()]);
    const waiting = stillWaiting(questions, memories).length;
    if (waiting !== state.openQuestions) {
      state.openQuestions = waiting;
      emit();
    }
  } catch {
    // Leave the last count; the next poll will try again.
  }
}

export function startPolling() {
  clearInterval(timer);
  refreshNotifications();
  timer = setInterval(refreshNotifications, POLL_MS);
}
