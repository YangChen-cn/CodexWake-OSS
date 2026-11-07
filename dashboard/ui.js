"use strict";
const byId = (id) => document.getElementById(id);
let token = document.querySelector('meta[name="codexwake-csrf"]').content;
const form = byId("settings");
const notice = byId("notice");
let cloud = null;
let busy = false;
const remote = document.body.dataset.mode === "remote";
const booking = byId("appointment-form");
let editing = null;

const reasons = {
  waiting_for_reset: "等待额度重置",
  sleeping: "等待睡眠时段结束",
  outside_allowed_hours: "等待允许时段",
  appointment_covered: "本轮已有一次预热",
  appointment_window_unavailable: "已知窗口未重置，预约内无可用时段",
  model_attestation_missing: "模型尚未验证",
  credentials_unavailable: "凭证不可用或正在更新",
  activity_wakes_not_enabled: "自动预热未通过线上验收",
  canceled: "已取消",
  permit_issued: "一次性许可已消费",
  disabled: "已暂停",
  reset_changed: "重置时间变化，窗口待确认",
  permit_not_granted: "未获得发送许可",
  activity_expired: "计划已过期",
  completed_unverified: "CLI 已完成，窗口启动未验证",
  unconfirmed: "请求结果不明",
  not_started: "请求未启动",
  disabled_or_busy: "自动预热关闭或协调器忙",
};
const explain = (reason) => reasons[reason] ?? reason ?? "未知";
const errors = {
  cloud_unavailable: "无法连接 Cloudflare。",
  revision_conflict: "云端状态已变化。请刷新后重新提交。",
  activation_unavailable: "自动预热当前不可开启。",
  invalid_appointments: "请检查预约的日期、时段和分钟数。",
  invalid_config: "请检查时区、时段及消息。",
  dashboard_managed: "面板由 macOS 管理。可运行 npm run dashboard:uninstall 停止按需服务。",
  request_unconfirmed: "请求结果未确认。请刷新云端状态。",
};
const time = (ms) => Number.isFinite(ms) ? new Date(ms).toLocaleString("zh-CN", {
  timeZone: cloud?.config.timeZone ?? "Asia/Hong_Kong", hour12: false,
}) : "未知";

async function api(path, body, retry = true) {
  const method = remote && ["/api/config", "/api/appointments"].includes(path) ? "PUT" : "POST";
  const response = await fetch(path, body === undefined ? {} : { method,
    headers: { "Content-Type": "application/json", "X-CodexWake-CSRF": token }, body: JSON.stringify(body) });
  const result = await response.json();
  // A new on-demand process has a new CSRF token. This response confirms
  // the server rejected the request before applying any changes.
  if (retry && body !== undefined && response.status === 403 && result.error === "csrf_rejected") {
    token = (await api("/api/csrf")).csrf;
    return api(path, body, false);
  }
  if (!response.ok) throw new Error(errors[result.error] ?? "操作未确认。");
  return result;
}

function showQuota(snapshot, live = false) {
  byId("quota").textContent = snapshot && Number.isFinite(snapshot.usedPercent)
    ? `${live ? "刚读取" : "上次观测"} · 已用 ${snapshot.usedPercent}% · 恢复 ${time(snapshot.resetAtMs)}`
    : "未知";
}

async function refresh({ fill = true } = {}) {
  const state = await api("/api/status");
  cloud = state.cloud;
  const local = state.local ?? {};
  byId("monitor").textContent = remote ? "远程面板 · 仅显示上报状态" : local.paused ? "监听已暂停" : local.installed === true ? "Hook 已安装 · 按事件运行"
    : local.installed === false ? "Hook 未安装" : "安装状态未知";
  showQuota(local.last ?? cloud?.activityWake);
  const arm = cloud?.activityWake;
  const pending = arm?.status === "armed" || arm?.status === "reserved";
  const plan = cloud?.wakePlan;
  const next = plan?.pending;
  const source = { user_activity: "本机活动", rolling: "估算滚动", appointment: "主动预约" }[next?.source];
  const armText = next ? `${source} · 最早 ${time(next.dueAtMs)} · 截止 ${time(next.expiresAtMs)}`
    : arm ? (pending ? `用户活动 · 预计 ${time(arm.dueAtMs)} 后可发送${arm.reason ? " · " + explain(arm.reason) : ""}` : `用户活动 · ${explain(arm.reason)}`) : "暂无布防";
  byId("wake").textContent = !cloud ? "未知" : cloud.automaticBlockReason ? explain(cloud.automaticBlockReason)
    : !cloud.config.autoEnabled ? "已暂停" : armText;
  byId("last").textContent = `最近真实活动 ${time(local.lastActivityAtMs ?? arm?.activityAtMs)} · 最近结果 ${explain(cloud?.lastActivityWake?.outcome ?? cloud?.lastActivation?.outcome)}`;
  byId("config-fields").disabled = !cloud;
  document.querySelector('[data-control="resume"]').disabled = !cloud || !!cloud.automaticBlockReason;
  document.querySelector('[data-control="pause"]').disabled = !cloud;
  document.querySelector('[data-control="cancel"]').disabled = !cloud;
  if (cloud && fill) {
    for (const input of form.querySelectorAll("[name]")) {
      if (input.type === "checkbox") input.checked = cloud.config[input.name];
      else input.value = cloud.config[input.name] ?? "";
    }
  }
  form.elements.model.readOnly = remote && cloud?.verifiedModel === cloud?.config.model;
  form.elements.autoEnabled.disabled = !cloud || !!cloud.automaticBlockReason;
  byId("appointment-fields").disabled = !cloud;
  byId("appointment-summary").textContent = plan
    ? `连续预热 ${plan.idleWakes}/${cloud.config.maxIdleWakes} · ${plan.resetSource === "estimated" ? "预计" : "观测"}恢复 ${time(plan.resetAtMs)}` : "";
  renderAppointments();
  updateBookingEnd();
  if (state.error) notice.textContent = errors[state.error];
  return cloud;
}

async function run(action) {
  if (busy) return;
  busy = true;
  notice.textContent = "正在处理…";
  try { await action(); }
  catch (error) { notice.textContent = error.message || "连接失败。请刷新后重试。"; }
  finally { busy = false; }
}

byId("refresh").onclick = () => run(async () => { if (await refresh()) notice.textContent = "状态已更新。"; });
byId("read-quota").onclick = () => run(async () => {
  const result = await api("/api/quota", {});
  showQuota(result, true);
  notice.textContent = result.outcome === "read_only" ? "已读取额度。" : "额度未知。请检查独立观察登录或等待正在运行的探测结束。";
});
byId("exit").onclick = () => run(async () => { await api("/api/exit", {}); notice.textContent = "面板服务已退出，可关闭此页。"; });
for (const button of document.querySelectorAll("[data-control]")) button.onclick = () => run(async () => {
  const action = button.dataset.control;
  const result = await api(remote ? "/api/" + action : "/api/control", {
    ...(remote ? {} : { action }), revision: cloud?.revision,
  });
  if (await refresh()) notice.textContent = result.permitAlreadyIssued ? "已取消后续预热。已有发送许可的请求可能完成。" : "已确认云端状态。";
});
for (const button of document.querySelectorAll("[data-monitor]")) button.onclick = () => run(async () => {
  await api("/api/monitor", { action: button.dataset.monitor });
  await refresh({ fill: false });
  notice.textContent = "本机监测设置已更新。";
});
form.onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const settings = Object.fromEntries(Array.from(form.querySelectorAll("[name]"), (input) =>
      [input.name, input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value || null]));
    await api("/api/config", { revision: cloud?.revision, settings });
    if (await refresh()) notice.textContent = "已保存并确认云端设置。";
  });
};

const appointmentKeys = ["id", "startAtMs", "endAtMs", "recoveryMinutes", "repeat"];

function localParts(ms) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: cloud.config.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
}

function inputTime(ms) {
  const p = localParts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function zonedTime(value) {
  const utc = Date.parse(value + "Z");
  if (!Number.isFinite(utc)) throw new Error("请填写有效的预约时间。");
  let timestamp = utc;
  for (let i = 0; i < 3; i++) {
    timestamp += utc - Date.parse(inputTime(timestamp) + "Z");
  }
  if (inputTime(timestamp) !== value) throw new Error("这个本地时间在所选时区不存在。");
  return timestamp;
}

const durationPresets = [60, 120, 180, 240];
const minuteMs = 60000;

function bookingEnd(startAtMs) {
  const { duration, end } = booking.elements;
  return duration.value === "custom" ? zonedTime(end.value) : startAtMs + Number(duration.value) * minuteMs;
}

function updateBookingEnd() {
  const { duration, start, end } = booking.elements;
  const custom = duration.value === "custom";
  byId("custom-end").hidden = !custom;
  end.disabled = !custom;
  end.required = custom;
  const preview = byId("appointment-end-preview");
  preview.hidden = custom;
  if (custom) return;
  preview.textContent = "填入开始时间后，自动计算结束时间。";
  if (!cloud || !start.value) return;
  try {
    const endAtMs = bookingEnd(zonedTime(start.value));
    end.value = inputTime(endAtMs);
    preview.textContent = `预计结束 ${time(endAtMs)}（${cloud.config.timeZone}）`;
  } catch {
    end.value = "";
    preview.textContent = "请选择有效的开始时间。";
  }
}

function clearBooking() {
  editing = null;
  booking.reset();
  updateBookingEnd();
  byId("custom-recovery").hidden = true;
  byId("save-appointment").textContent = "添加预约";
}

async function saveAppointments(appointments) {
  await api("/api/appointments", { revision: cloud.revision,
    appointments: appointments.map((item) => Object.fromEntries(appointmentKeys.map((key) => [key, item[key]]))) });
  clearBooking();
  if (await refresh()) notice.textContent = "预约已保存到云端。";
}

function renderAppointments() {
  const list = byId("appointment-list");
  list.replaceChildren();
  const items = cloud?.wakePlan?.appointments ?? [];
  for (const item of items) {
    const row = document.createElement("li");
    const detail = item.next ? ` · 最早预热 ${time(item.next.dueAtMs)}${item.next.reason ? " · " + explain(item.next.reason) : ""}` : " · 已完成或过期";
    row.append(`${time(item.next?.startAtMs ?? item.startAtMs)} 至 ${time(item.next?.endAtMs ?? item.endAtMs)}${detail}`);
    for (const [label, action] of [["编辑", () => {
      editing = item.id;
      booking.elements.start.value = inputTime(item.startAtMs);
      booking.elements.end.value = inputTime(item.endAtMs);
      const duration = (item.endAtMs - item.startAtMs) / minuteMs;
      booking.elements.duration.value = durationPresets.includes(duration) ? String(duration) : "custom";
      updateBookingEnd();
      booking.elements.repeat.value = item.repeat;
      booking.elements.preset.value = item.recoveryMinutes === null ? "start" : [60, 120].includes(item.recoveryMinutes) ? String(item.recoveryMinutes) : "custom";
      booking.elements.recovery.value = item.recoveryMinutes ?? 90;
      byId("custom-recovery").hidden = booking.elements.preset.value !== "custom";
      byId("save-appointment").textContent = "保存预约";
    }], ["取消预约", () => run(() => saveAppointments(items.filter(({ id }) => id !== item.id)))]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = action;
      row.append(button);
    }
    list.append(row);
  }
}

booking.elements.start.addEventListener("input", updateBookingEnd);
booking.elements.duration.addEventListener("change", updateBookingEnd);
booking.elements.preset.onchange = () => { byId("custom-recovery").hidden = booking.elements.preset.value !== "custom"; };
byId("clear-appointment").onclick = clearBooking;
booking.onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const { start, preset, recovery, repeat } = booking.elements;
    const startAtMs = zonedTime(start.value);
    const endAtMs = bookingEnd(startAtMs);
    if (endAtMs <= startAtMs || endAtMs <= Date.now()) throw new Error("预约结束时间须晚于开始时间和现在。");
    const id = editing ?? crypto.randomUUID();
    const item = { id, startAtMs, endAtMs, repeat: repeat.value,
      recoveryMinutes: preset.value === "start" ? null : Number(preset.value === "custom" ? recovery.value : preset.value) };
    const items = cloud.wakePlan?.appointments ?? [];
    await saveAppointments([...items.filter((old) => old.id !== id), item]);
  });
};

run(async () => { if (await refresh()) notice.textContent = "已连接 Cloudflare。"; });
