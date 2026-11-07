"use strict";
const $ = (s, root = document) => root.querySelector(s);
const money = (n) =>
  "₹" +
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const date = (s) =>
  s
    ? new Date(s + "T12:00:00").toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const S = {
  user: null,
  mine: [],
  queue: [],
  allVouchers: [],
  users: [],
  projects: [],
  proofFiles: [],
  expenseItems: [],
  view: "dashboard",
  query: "",
  statusFilter: "",
  projectFilter: "",
  fromFilter: "",
  toFilter: "",
  ownerFilter: "",
  userQuery: "",
  userRoleFilter: "",
  userStatusFilter: "",
  paymentTab: "action",
};
const roleNames = {
  employee: "Employee",
  hr: "HR reviewer",
  admin: "Administrator",
  accounts: "Accounts",
};
const travelMediums = [
  "Taxi / app cab", "Company vehicle", "Personal car", "Personal two-wheeler",
  "Auto-rickshaw", "Bus", "Train", "Airplane / commercial flight",
  "Charter flight", "Helicopter", "Ferry / boat", "Other",
];
function normalise(v) {
  return {
    ...v,
    from: v.origin,
    to: v.destination,
    project: v.project_name,
    project_id: v.project_id,
    date: v.travel_date,
    mode: v.medium,
    total: Number(v.amount),
    owner: v.employee_name,
    lines: (v.expenses || []).map((x) => [
      x.description,
      x.category,
      Number(x.amount),
      x.bill_number || "",
      x.medium || v.medium,
      x.attachments || [],
      x.id,
    ]),
    proofs: v.attachments || [],
    trail: (v.events || []).map((x) => [
      `${x.actor} · ${roleNames[x.role] || x.role} ${x.action}`,
      new Date(x.at).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ]),
  };
}
async function api(path, options = {}) {
  const request = {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch("/api" + path, request);
      break;
    } catch (err) {
      const canRetry = (request.method || "GET").toUpperCase() === "GET" && attempt === 0;
      if (!canRetry) {
        throw new Error("RouteBack could not reach the server. Check the connection and try again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    if (res.status === 401) {
      showLogin();
    }
    let message = data.detail || data.error || `Request failed (${res.status})`;
    if (Array.isArray(message)) {
      message = message
        .map((issue) => {
          const field = issue.loc?.at(-1);
          if (field === "username")
            return "Username: use letters, numbers, dots, underscores or hyphens; no spaces.";
          if (field === "password")
            return "Password: use 8–12 characters with at least one letter and one number.";
          if (field === "role") return "Choose a valid account role.";
          return issue.msg || "Please check the submitted details.";
        })
        .join(" ");
    }
    throw new Error(typeof message === "string" ? message : `Request failed (${res.status})`);
  }
  return data;
}
function toast(msg) {
  let t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2600);
}
function showLogin() {
  S.user = null;
  $("#app").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
}
function showApp() {
  $("#loginScreen").classList.add("hidden");
  $("#app").classList.remove("hidden");
}
async function load() {
  let [d, projects] = await Promise.all([api("/vouchers"), api("/projects")]);
  S.user = d.user;
  S.mine = d.mine.map(normalise);
  S.queue = d.queue.map(normalise);
  S.allVouchers = (d.all_vouchers || []).map(normalise);
  S.projects = projects;
  showApp();
  render();
}
async function boot() {
  try {
    let d = await api("/auth/me");
    S.user = d.user;
    await load();
  } catch {
    showLogin();
  }
}
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginError").textContent = "";
  const form = e.currentTarget;
  let f = new FormData(form);
  try {
    await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: f.get("username"),
        password: f.get("password"),
      }),
    });
    form.reset();
    await load();
  } catch (err) {
    $("#loginError").textContent = err.message;
  }
});
async function signOut() {
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
  } finally {
    showLogin();
  }
}
$("#logoutButton").onclick = signOut;
$("#topLogout").onclick = signOut;
function pill(s) {
  return `<span class="pill pill-${s.toLowerCase().replaceAll(" ", "-")}">${esc(s)}</span>`;
}
function route(v) {
  const journey = [v.from, v.to].filter(Boolean).map(esc).join(" → ");
  return `<span class="route"><b>${journey || (v.project ? `Project: ${esc(v.project)}` : "Travel claim")}</b><small>${date(v.date)} · ${esc(v.mode)}${v.project && journey ? ` · ${esc(v.project)}` : ""}</small></span>`;
}
function row(v) {
  return `<tr><td><a class="voucher-id" data-open="${esc(v.id)}">${esc(v.id)}</a></td><td>${route(v)}</td><td>${esc(v.purpose)}</td><td class="amount">${money(v.total)}</td><td>${pill(v.status)}</td><td><button class="btn btn-small" data-open="${esc(v.id)}">View</button></td></tr>`;
}
function allVisible() {
  return [...S.mine, ...S.queue];
}
function pageHead(k, title, sub, btn = "") {
  return `<div class="page-head"><div><div class="eyebrow">${k}</div><h1>${title}</h1><div class="subhead">${sub}</div></div>${btn}</div>`;
}
function timeline(v) {
  let stages = [
      "HR review",
      "Admin approval",
      "Accounts review",
      "Payment processing",
      "Payment received",
      "Closed",
    ],
    idx = stages.indexOf(v?.status);
  if (idx < 0) idx = 0;
  return `<div class="timeline">${stages.map((s, i) => `<div class="step ${i < idx ? "done" : i === idx ? "current" : ""}"><div class="step-dot">${i < idx ? "✓" : i + 1}</div><div><b>${s}</b><small>${i === idx ? "Current step" : i < idx ? "Completed" : "Waiting"}</small></div></div>`).join("")}</div>`;
}
function actionFor(v) {
  let r = S.user.role;
  if (v.employee_id !== S.user.id && v.status === "HR review" && r === "hr")
    return ["verify", "Verify travel details"];
  if (
    v.employee_id !== S.user.id &&
    v.status === "Admin approval" &&
    r === "admin"
  )
    return ["approve", "Approve as Admin"];
  if (
    v.employee_id !== S.user.id &&
    v.status === "Accounts review" &&
    r === "accounts"
  )
    return ["approve", "Approve for payment"];
  if (
    v.employee_id !== S.user.id &&
    v.status === "Payment processing" &&
    r === "accounts"
  )
    return ["mark_paid", "Record payment sent"];
  if (v.status === "Payment received" && v.employee_id === S.user.id)
    return ["confirm_receipt", "Confirm I received payment"];
  return null;
}
function metricCard(label, value, note, icon) {
  return `<div class="metric"><div class="metric-top"><span class="metric-label">${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`;
}
function applyVoucherFilters(items) {
  const query = S.query.trim().toLowerCase();
  return items.filter((v) => {
    const details = (v.lines || []).flat().join(" ");
    const haystack = `${v.id} ${v.owner} ${v.from} ${v.to} ${v.purpose} ${v.status} ${v.project || ""} ${v.medium || ""} ${details}`.toLowerCase();
    return (!query || haystack.includes(query)) &&
      (!S.statusFilter || v.status === S.statusFilter) &&
      (!S.projectFilter || String(v.project_id || "") === S.projectFilter) &&
      (!S.ownerFilter || String(v.employee_id || "") === S.ownerFilter) &&
      (!S.fromFilter || String(v.date || "") >= S.fromFilter) &&
      (!S.toFilter || String(v.date || "") <= S.toFilter);
  });
}
function statusFilter(items) {
  const allStatuses = ["HR review", "Admin approval", "Accounts review", "Payment processing", "Payment received", "Closed", "Rejected"];
  const present = new Set(items.map((v) => v.status));
  return `<select id="statusFilter" aria-label="Filter by status"><option value="">All statuses</option>${allStatuses.filter((status) => present.has(status)).map((status) => `<option value="${esc(status)}" ${S.statusFilter === status ? "selected" : ""}>${esc(status)}</option>`).join("")}</select>`;
}
function voucherFilters(items, placeholder, countLabel) {
  const projects = [...new Map(items.filter((v) => v.project_id).map((v) => [v.project_id, { id: v.project_id, name: v.project || "Project" }])).values()];
  const projectOptions = [...new Map([...S.projects, ...projects].map((p) => [p.id, p])).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${esc(p.id)}" ${S.projectFilter === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const canFilterOwner = ["admin", "hr", "accounts"].includes(S.user.role);
  const owners = canFilterOwner
    ? [...new Map(S.allVouchers.map((v) => [v.employee_id, { id: v.employee_id, name: v.owner }])).values()].sort((a, b) => a.name.localeCompare(b.name))
    : [];
  return `<div class="filters filter-bar"><input id="search" type="search" placeholder="${placeholder}" value="${esc(S.query)}">${statusFilter(items)}<select id="projectFilter" aria-label="Filter by project"><option value="">All projects</option>${projectOptions}</select>${canFilterOwner ? `<select id="ownerFilter" aria-label="Filter by employee"><option value="">All employees</option>${owners.map((o) => `<option value="${esc(o.id)}" ${S.ownerFilter === o.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>` : ""}<label class="filter-date"><span>From</span><input id="fromFilter" type="date" value="${esc(S.fromFilter)}"></label><label class="filter-date"><span>To</span><input id="toFilter" type="date" value="${esc(S.toFilter)}"></label><span class="filter-count">${countLabel}</span><button class="btn btn-small" id="clearVoucherFilters" type="button">Clear</button></div>`;
}
function dashboard() {
  const isEmployee = S.user.role === "employee";
  const isAdmin = S.user.role === "admin";
  const global = S.allVouchers;
  const scope = isEmployee ? S.mine : global;
  const inProgress = scope.filter((v) => !["Closed", "Rejected"].includes(v.status));
  const closed = scope.filter((v) => v.status === "Closed");
  const total = scope.reduce((sum, v) => sum + v.total, 0);
  const recent = (isEmployee ? S.mine : global).slice(0, 5);
  const queue = S.queue.filter((v) => actionFor(v));
  const kpis = isAdmin
    ? [
        metricCard("ALL VOUCHERS", global.length, "Across every employee", "▤"),
        metricCard("MY VOUCHERS", S.mine.length, "Submitted by you", "♙"),
        metricCard("IN PROGRESS", inProgress.length, "Across all employees", "◷"),
        metricCard("CLOSED", closed.length, "Payment confirmed", "✓"),
        metricCard("TOTAL CLAIMED", money(total), "Across all vouchers", "₹"),
      ].join("")
    : isEmployee
      ? [
          metricCard("MY VOUCHERS", S.mine.length, "Submitted by you", "▤"),
          metricCard("IN PROGRESS", inProgress.length, "Waiting for a review or payment", "◷"),
          metricCard("CLOSED", closed.length, "Payment confirmed by you", "✓"),
          metricCard("TOTAL CLAIMED", money(total), "Across your vouchers", "₹"),
        ].join("")
      : [
          metricCard("ALL VOUCHERS", global.length, "Across every employee", "▤"),
          metricCard("IN PROGRESS", inProgress.length, "Awaiting review or payment", "◷"),
          metricCard("CLOSED", closed.length, "Payment confirmed", "✓"),
          metricCard("TOTAL CLAIMED", money(total), "Across all vouchers", "₹"),
        ].join("");
  const recentRows = isEmployee
    ? recent.map(row).join("")
    : recent.map((v) => `<tr><td><a class="voucher-id" data-open="${esc(v.id)}">${esc(v.id)}</a></td><td>${esc(v.owner)}</td><td>${route(v)}</td><td>${esc(v.purpose)}</td><td class="amount">${money(v.total)}</td><td>${pill(v.status)}</td><td><button class="btn btn-small" data-open="${esc(v.id)}">View</button></td></tr>`).join("");
  const recentHeading = isEmployee ? "My recent vouchers" : "Recent vouchers";
  const recentSubheading = isEmployee ? "Your claims and their current status" : "Latest claims across all employees";
  const recentLink = isEmployee ? "vouchers" : "allVouchers";
  const recentHeaders = isEmployee
    ? "<th>Voucher</th><th>Journey</th><th>Purpose</th><th>Claim</th><th>Status</th><th></th>"
    : "<th>Voucher</th><th>Employee</th><th>Journey</th><th>Purpose</th><th>Claim</th><th>Status</th><th></th>";
  const recentEmpty = isEmployee ? "You haven’t submitted a travel voucher yet." : "No vouchers have been submitted yet.";
  const next = S.queue[0] || S.mine.find((v) => !["Closed", "Rejected"].includes(v.status));
  return `${pageHead("SITE TRAVEL CLAIMS", `Welcome, ${esc(S.user.display_name.split(" ")[0])}`, "Your site travel vouchers and reimbursement status.", '<button class="btn btn-primary" id="newVoucher">＋ New voucher</button>')}<section class="metrics ${isAdmin ? "metrics-global" : ""}">${kpis}</section><section class="content-grid"><div class="card"><div class="card-head"><div><h2>${recentHeading}</h2><p>${recentSubheading}</p></div><button class="text-link" data-view="${recentLink}">See all →</button></div><div class="table-wrap"><table><thead><tr>${recentHeaders}</tr></thead><tbody>${recentRows || `<tr><td colspan="${isEmployee ? 6 : 7}" class="empty">${recentEmpty}</td></tr>`}</tbody></table></div></div><div class="card"><div class="card-head"><div><h2>${isEmployee ? "Approval journey" : "Review queue"}</h2><p>${isEmployee ? "Every claim follows the same sequence" : `${queue.length} voucher${queue.length === 1 ? "" : "s"} need your action`}</p></div>${isEmployee ? "" : '<button class="text-link" data-view="approvals">Open queue →</button>'}</div>${isEmployee ? timeline(next) : `<div class="timeline">${queue.slice(0, 4).map((v) => `<div class="step current"><div class="step-dot">•</div><div><b>${esc(v.id)} · ${esc(v.owner)}</b><small>${esc(v.purpose)} · ${esc(v.status)}</small></div></div>`).join("") || '<div class="empty">No vouchers currently need your review.</div>'}</div>`}</div></section><section class="content-grid" style="margin-top:16px"><div class="card"><div class="card-head"><div><h2>Reimbursement steps</h2><p>From site trip to confirmed payment</p></div></div><div class="timeline"><div class="step"><div class="step-dot">1</div><div><b>Employee submits journey, costs and proofs</b><small>Only the submitting employee can view and confirm their own claim.</small></div></div><div class="step"><div class="step-dot">2</div><div><b>HR verifies the claim</b><small>Travel route, purpose, expense details and supporting bills.</small></div></div><div class="step"><div class="step-dot">3</div><div><b>Admin approval · Vipul Sir</b><small>Approved vouchers move to Accounts.</small></div></div><div class="step"><div class="step-dot">4</div><div><b>Accounts approves and records payment</b><small>Employee confirms receipt to close the voucher.</small></div></div></div></div><div class="card"><div class="card-head"><div><h2>Keep proofs ready</h2><p>Receipts and tickets help speed up review.</p></div></div><div class="detail-body"><div class="banner">Attach receipts, tickets, tolls, parking bills and other site travel proofs with each voucher.</div><button class="btn btn-primary" id="newVoucher2">＋ Create a travel voucher</button></div></div></section>`;
}
function vouchersPage() {
  const rows = applyVoucherFilters(S.mine);
  return `${pageHead("YOUR CLAIMS", "My vouchers", "Vouchers submitted under your account.", '<button class="btn btn-primary" id="newVoucher">＋ New voucher</button>')}${voucherFilters(S.mine, "Search voucher, journey or purpose…", `${rows.length} of ${S.mine.length} vouchers`)}<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Journey</th><th>Purpose</th><th>Claim amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(row).join("") || '<tr><td colspan="6" class="empty">No vouchers match these filters.</td></tr>'}</tbody></table></div></div>`;
}
function allVouchersPage() {
  const rows = applyVoucherFilters(S.allVouchers);
  const allRow = (v) => `<tr><td><a class="voucher-id" data-open="${esc(v.id)}">${esc(v.id)}</a></td><td>${esc(v.owner)}</td><td>${route(v)}</td><td>${esc(v.purpose)}</td><td class="amount">${money(v.total)}</td><td>${pill(v.status)}</td><td><button class="btn btn-small" data-open="${esc(v.id)}">View</button></td></tr>`;
  return `${pageHead("VOUCHER REGISTER", "All vouchers", "Follow every employee voucher through review, payment and closure.", "")}${voucherFilters(S.allVouchers, "Search voucher, employee or journey…", `${rows.length} of ${S.allVouchers.length} vouchers`)}<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Employee</th><th>Journey</th><th>Purpose</th><th>Claim</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(allRow).join("") || '<tr><td colspan="7" class="empty">No vouchers match these filters.</td></tr>'}</tbody></table></div></div>`;
}
function approvalsPage() {
  const rows = applyVoucherFilters(S.queue);
  return `${pageHead("REVIEW CENTRE", "Approval queue", "Vouchers currently awaiting your role’s action.", "")}${voucherFilters(S.queue, "Search voucher, employee or purpose…", `${rows.length} of ${S.queue.length} actions`)}<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Employee & journey</th><th>Purpose</th><th>Claim</th><th>Stage</th><th>Action</th></tr></thead><tbody>${rows.map(row).join("") || '<tr><td colspan="6" class="empty">No vouchers match these filters.</td></tr>'}</tbody></table></div></div>`;
}
function paymentsPage() {
  const source = S.user.role === "employee" ? S.mine : S.allVouchers;
  const history = source;
  const actionable = source.filter((v) => actionFor(v));
  const selected = S.paymentTab === "history" ? history : actionable;
  const rows = applyVoucherFilters(selected);
  const paymentRow = (v) => `<tr><td><a class="voucher-id" data-open="${esc(v.id)}">${esc(v.id)}</a></td><td>${esc(v.owner)}</td><td>${route(v)}</td><td>${esc(v.purpose)}</td><td class="amount">${money(v.total)}</td><td>${pill(v.status)}</td><td><button class="btn btn-small" data-open="${esc(v.id)}">View</button></td></tr>`;
  return `${pageHead("REIMBURSEMENTS", "Payments", "Track every voucher and focus on the actions waiting for your role.", "")}<div class="view-tabs" role="tablist"><button class="view-tab ${S.paymentTab === "action" ? "active" : ""}" data-payment-tab="action">Action required <span>${actionable.length}</span></button><button class="view-tab ${S.paymentTab === "history" ? "active" : ""}" data-payment-tab="history">All vouchers <span>${history.length}</span></button></div>${voucherFilters(selected, "Search voucher, employee or journey…", `${rows.length} of ${selected.length} records`)}<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Employee</th><th>Journey</th><th>Purpose</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(paymentRow).join("") || `<tr><td colspan="7" class="empty">${S.paymentTab === "action" ? "No vouchers currently need your action." : "No voucher records match these filters."}</td></tr>`}</tbody></table></div></div>`;
}
function reportsPage() {
  const rows = applyVoucherFilters(S.allVouchers);
  const reportRow = (v) => `<tr><td><a class="voucher-id" data-open="${esc(v.id)}">${esc(v.id)}</a></td><td>${esc(v.owner)}</td><td>${esc(v.project || "—")}</td><td>${route(v)}</td><td>${date(v.date)}</td><td>${esc(v.medium || "—")}</td><td class="amount">${money(v.total)}</td><td>${pill(v.status)}</td></tr>`;
  return `${pageHead("REPORTING", "Voucher report", "Filter the reimbursement register, then export the matching expense details.", '<button class="btn btn-primary" id="exportFilteredCsv">⇩ Download CSV</button>')}${voucherFilters(S.allVouchers, "Search voucher, employee, location or item…", `${rows.length} of ${S.allVouchers.length} vouchers`)}<div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Employee</th><th>Project</th><th>Journey / location</th><th>Date</th><th>Travel modes</th><th>Claim total</th><th>Status</th></tr></thead><tbody>${rows.map(reportRow).join("") || '<tr><td colspan="8" class="empty">No vouchers match these filters.</td></tr>'}</tbody></table></div></div>`;
}
function exportFilteredCsv() {
  const params = new URLSearchParams();
  if (S.query.trim()) params.set("search", S.query.trim());
  if (S.statusFilter) params.set("status", S.statusFilter);
  if (S.projectFilter) params.set("project_id", S.projectFilter);
  if (S.ownerFilter) params.set("employee_id", S.ownerFilter);
  if (S.fromFilter) params.set("from", S.fromFilter);
  if (S.toFilter) params.set("to", S.toFilter);
  const link = document.createElement("a");
  link.href = `/api/reports/vouchers.csv?${params.toString()}`;
  link.click();
}
function usersPage() {
  const q = S.userQuery.trim().toLowerCase();
  const users = S.users.filter((u) =>
    (!q || `${u.display_name} ${u.username}`.toLowerCase().includes(q)) &&
    (!S.userRoleFilter || u.role === S.userRoleFilter) &&
    (!S.userStatusFilter || String(u.active) === S.userStatusFilter)
  );
  const rows = users.map((u) => `<tr><td><b>${esc(u.display_name)}</b><small class="table-secondary">${esc(u.username)}</small></td><td><span class="role-label">${esc(roleNames[u.role] || u.role)}</span></td><td>${u.active ? '<span class="pill pill-closed">Active</span>' : '<span class="pill pill-rejected">Inactive</span>'}</td><td>${date(u.created_at.slice(0, 10))}</td><td class="user-row-actions"><button class="btn btn-small" data-user-edit="${u.id}">Edit details</button><button class="btn btn-small" data-user-reset="${u.id}">Reset password</button><button class="btn btn-small" data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? "Deactivate" : "Reactivate"}</button></td></tr>`).join("");
  return `${pageHead("ADMINISTRATION", "People & roles", "Manage account details, access and sign-in credentials.", "")}<section class="card user-create-card" style="margin-bottom:14px"><div class="card-head"><div><h2>Create an account</h2><p>Every employee has an individual sign-in and private voucher list.</p></div></div><form id="userForm" class="detail-body form-grid" novalidate><div class="form-field"><label>Full name</label><input name="display_name" maxlength="200" placeholder="e.g. Human Resources"></div><div class="form-field"><label>Username</label><input name="username" maxlength="120" autocomplete="off" placeholder="e.g. hr or human.resources"><small class="form-hint">Letters, numbers, dots, underscores and hyphens.</small></div><div class="form-field"><label>Role</label><select name="role"><option value="employee">Employee</option><option value="hr">HR</option><option value="admin">Admin</option><option value="accounts">Accounts</option></select></div><div class="form-field"><label>Initial password · 8–12 characters</label><input name="password" type="password" maxlength="12" autocomplete="new-password" placeholder="Include letters and numbers"></div><div class="form-field full"><div id="userError" class="login-error" role="alert"></div><button class="btn btn-primary" type="submit">＋ Create account</button></div></form></section><section class="card"><div class="card-head"><div><h2>User accounts</h2><p>${S.users.length} accounts · Edit names, usernames, roles and account status.</p></div></div><div class="filters filter-bar user-filters"><input id="userSearch" type="search" placeholder="Search name or username" value="${esc(S.userQuery)}"><select id="userRoleFilter"><option value="">All roles</option>${Object.entries(roleNames).map(([key, name]) => `<option value="${key}" ${S.userRoleFilter === key ? "selected" : ""}>${esc(name)}</option>`).join("")}</select><select id="userStatusFilter"><option value="">All statuses</option><option value="true" ${S.userStatusFilter === "true" ? "selected" : ""}>Active</option><option value="false" ${S.userStatusFilter === "false" ? "selected" : ""}>Inactive</option></select><span class="filter-count">${users.length} of ${S.users.length} accounts</span></div><div class="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Created</th><th>Manage</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">No accounts match these filters.</td></tr>'}</tbody></table></div></section>`;
}function projectsPage() {
  return `${pageHead("ADMINISTRATION", "Projects", "Manage project names and the locations employees can select on vouchers.", "")}<div class="banner">Locations are suggestions tied to a project. Employees can still type a different location on any voucher.</div><section class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>Add a project</h2><p>Add optional site or destination locations, one per line.</p></div></div><form id="projectForm" class="detail-body form-grid"><div class="form-field"><label>Project name</label><input name="name" maxlength="200" required placeholder="e.g. North Plant Upgrade"></div><div class="form-field"><label>Locations · optional</label><textarea name="locations" rows="3" placeholder="Main Site&#10;Camp Office&#10;Jetty"></textarea></div><div class="form-field full"><div id="projectError" class="login-error" role="alert"></div><button class="btn btn-primary" type="submit">＋ Add project</button></div></form></section><section class="card"><div class="card-head"><div><h2>Selectable projects</h2><p>${S.projects.length} active project${S.projects.length === 1 ? "" : "s"}</p></div></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Voucher locations</th><th></th></tr></thead><tbody>${S.projects.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${(p.locations || []).map((location) => `<span class="location-tag">${esc(location)}</span>`).join("") || '<span class="subhead">No saved locations</span>'}</td><td><button class="btn btn-small" data-project-edit="${p.id}">Edit project</button></td></tr>`).join("") || '<tr><td colspan="3" class="empty">No projects added yet.</td></tr>'}</tbody></table></div></section>`;
}function miscPage() {
  return `${pageHead("WORKSPACE", "Travel policy", "Guidance for submitting a complete site travel claim.", "")}<div class="content-grid"><div class="card"><div class="card-head"><div><h2>What to include</h2><p>Help reviewers verify your claim.</p></div></div><div class="detail-body"><div class="activity"><b>Trip details</b><small>From and to locations, travel date, mode and site visit purpose.</small></div><div class="activity"><b>Expense breakdown</b><small>Fare, mileage, tolls, parking and other travel costs as separate items.</small></div><div class="activity"><b>Supporting proofs</b><small>Receipts, tickets and other supporting documents.</small></div></div></div><div class="card"><div class="card-head"><div><h2>Approval route</h2><p>Configured for this standalone site.</p></div></div><div class="detail-body"><div class="activity"><b>1 · HR review</b><small>Any active HR user can verify a submitted voucher.</small></div><div class="activity"><b>2 · Admin approval</b><small>Any active Admin can approve after HR verification.</small></div><div class="activity"><b>3 · Accounts review</b><small>Any active Accounts user can approve and record payment.</small></div><div class="activity"><b>4 · Employee confirmation</b><small>Only the voucher owner can confirm receipt and close it.</small></div></div></div></div>`;
}
async function refreshUsers() {
  if (S.user.role === "admin") S.users = await api("/users");
}
async function refreshProjects() {
  S.projects = await api("/projects");
}
async function render() {
  const names = {
    dashboard: "Overview",
    vouchers: "My vouchers",
    allVouchers: "All vouchers",
    approvals: "Approvals",
    payments: "Payments",
    reports: "Reports",
    people: "People & roles",
    projects: "Projects",
    policy: "Travel policy",
  };
  $("#crumb").textContent = names[S.view] || "Overview";
  $("#sideName").textContent = S.user.display_name;
  $("#sideRole").textContent = roleNames[S.user.role] || S.user.role;
  $("#sideAvatar").textContent = S.user.display_name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();
  $("#topAvatar").textContent = $("#sideAvatar").textContent;
  $("#topName").textContent = S.user.display_name;
  const isAdmin = S.user.role === "admin";
  const canSeeAll = ["admin", "hr", "accounts"].includes(S.user.role);
  const canSeeReports = ["admin", "hr", "accounts"].includes(S.user.role);
  $("#usersNav").classList.toggle("hidden", !isAdmin);
  $("#projectsNav").classList.toggle("hidden", !isAdmin);
  $("#allVouchersNav").classList.toggle("hidden", !canSeeAll);
  $("#reportsNav").classList.toggle("hidden", !canSeeReports);
  const canReview = ["hr", "admin", "accounts"].includes(S.user.role);
  $("#approvalsNav").classList.toggle("hidden", !canReview);
  $("#approvalCount").textContent = S.queue.filter((v) => actionFor(v)).length;
  $("#myCount").textContent = S.mine.length;
  const mobile = [["dashboard", "⌂", "Home"], ["vouchers", "▤", "Vouchers"]];
  if (canSeeAll) mobile.push(["allVouchers", "▤", "All"]);
  if (canReview) mobile.push(["approvals", "☷", "Review"]);
  mobile.push(["payments", "₹", "Payments"]);
  if (canSeeReports) mobile.push(["reports", "⇩", "Reports"]);
  if (isAdmin) mobile.push(["people", "♙", "People"], ["projects", "⌂", "Projects"]);
  $("#mobileNav").innerHTML = mobile.map(([id, icon, label]) => `<button class="mobile-nav-item ${S.view === id ? "active" : ""}" data-view="${id}"><span>${icon}</span>${label}</button>`).join("") + `<button class="mobile-nav-item mobile-add" id="mobileNew"><span>＋</span>New</button>`;
  if (S.view === "people" && isAdmin) await refreshUsers();
  if (S.view === "projects" && isAdmin) await refreshProjects();
  const pages = {
    dashboard,
    vouchers: vouchersPage,
    allVouchers: canSeeAll ? allVouchersPage : miscPage,
    approvals: canReview ? approvalsPage : miscPage,
    payments: paymentsPage,
    reports: canSeeReports ? reportsPage : miscPage,
    people: isAdmin ? usersPage : miscPage,
    projects: isAdmin ? projectsPage : miscPage,
    policy: miscPage,
  };
  $("#page").innerHTML = (pages[S.view] || miscPage)();
  bindPage();
}
function bindPage() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === S.view);
    button.onclick = (event) => {
      event.preventDefault();
      S.view = button.dataset.view;
      S.query = "";
      S.statusFilter = "";
      S.projectFilter = "";
      S.fromFilter = "";
      S.toFilter = "";
      S.ownerFilter = "";
      render();
    };
  });
  document.querySelectorAll("[data-payment-tab]").forEach((button) => {
    button.onclick = () => {
      S.paymentTab = button.dataset.paymentTab;
      S.query = "";
      S.statusFilter = "";
      S.projectFilter = "";
      S.fromFilter = "";
      S.toFilter = "";
      S.ownerFilter = "";
      render();
    };
  });
  document.querySelectorAll("#newVoucher,#newVoucher2").forEach((button) => (button.onclick = showCreate));
  const mobileNew = $("#mobileNew");
  if (mobileNew) mobileNew.onclick = showCreate;
  document.querySelectorAll("[data-open]").forEach((button) => (button.onclick = () => openDetail(button.dataset.open)));
  const search = $("#search");
  if (search) search.oninput = () => {
    S.query = search.value;
    const position = search.selectionStart;
    render().then(() => {
      const next = $("#search");
      if (next) { next.focus(); next.setSelectionRange(position, position); }
    });
  };
  const status = $("#statusFilter");
  if (status) status.onchange = () => { S.statusFilter = status.value; render(); };
  const projectFilter = $("#projectFilter");
  if (projectFilter) projectFilter.onchange = () => { S.projectFilter = projectFilter.value; render(); };
  const ownerFilter = $("#ownerFilter");
  if (ownerFilter) ownerFilter.onchange = () => { S.ownerFilter = ownerFilter.value; render(); };
  const fromFilter = $("#fromFilter");
  if (fromFilter) fromFilter.onchange = () => { S.fromFilter = fromFilter.value; render(); };
  const toFilter = $("#toFilter");
  if (toFilter) toFilter.onchange = () => { S.toFilter = toFilter.value; render(); };
  const clearFilters = $("#clearVoucherFilters");
  if (clearFilters) clearFilters.onclick = () => {
    S.query = "";
    S.statusFilter = "";
    S.projectFilter = "";
    S.fromFilter = "";
    S.toFilter = "";
    S.ownerFilter = "";
    render();
  };
  const userSearch = $("#userSearch");
  if (userSearch) userSearch.oninput = () => {
    S.userQuery = userSearch.value;
    const position = userSearch.selectionStart;
    render().then(() => {
      const next = $("#userSearch");
      if (next) { next.focus(); next.setSelectionRange(position, position); }
    });
  };
  const userRoleFilter = $("#userRoleFilter");
  if (userRoleFilter) userRoleFilter.onchange = () => { S.userRoleFilter = userRoleFilter.value; render(); };
  const userStatusFilter = $("#userStatusFilter");
  if (userStatusFilter) userStatusFilter.onchange = () => { S.userStatusFilter = userStatusFilter.value; render(); };
  const exportButton = $("#exportFilteredCsv");
  if (exportButton) exportButton.onclick = exportFilteredCsv;
  const form = $("#userForm");
  if (form) form.onsubmit = createUser;
  const projectForm = $("#projectForm");
  if (projectForm) projectForm.onsubmit = createProject;
  document.querySelectorAll("[data-user-edit]").forEach((button) => (button.onclick = () => editUser(button.dataset.userEdit)));
  document.querySelectorAll("[data-project-edit]").forEach((button) => (button.onclick = () => editProject(button.dataset.projectEdit)));
  document.querySelectorAll("[data-user-reset]").forEach((button) => (button.onclick = () => resetPassword(button.dataset.userReset)));
  document.querySelectorAll("[data-user-toggle]").forEach((button) => (button.onclick = () => toggleUser(button.dataset.userToggle, button.dataset.active === "true")));
}function modal(content, id, stack = false) {
  const root = $("#modalRoot");
  const markup = `<div class="modal-backdrop" id="${id}">${content}</div>`;
  if (stack) root.insertAdjacentHTML("beforeend", markup);
  else root.innerHTML = markup;
  const backdrop = $("#" + id);
  backdrop.addEventListener("click", (e) => {
    if (e.target.id !== id && !e.target.closest("[data-close]")) return;
    if (stack) backdrop.remove();
    else root.innerHTML = "";
  });
}
function createModal() {
  const projectOptions = S.projects
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join("");
  return `<form class="modal" id="voucherForm"><div class="modal-head"><h2>New site travel voucher</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="banner">Choose a project location or enter one manually. Add expenses separately, each with its own travel mode and proof files.</div><div class="form-grid"><div class="form-field full"><label>Project · optional</label><select name="project_id" id="projectSelect"><option value="">No project selected</option>${projectOptions}</select><small class="form-hint">Projects are selectable labels only; they do not determine user access.</small></div><div class="form-field"><label>From · required without a project</label><input name="origin" id="voucherOrigin" maxlength="240" placeholder="Enter start location"></div><div class="form-field"><label>To / project location · required without a project</label><input name="destination" id="voucherDestination" list="projectLocationOptions" maxlength="240" placeholder="Choose a suggestion or type any location"><datalist id="projectLocationOptions"></datalist><small class="form-hint">Project locations are suggestions; you can enter another location.</small></div><div class="form-field"><label>Travel date</label><input type="date" name="travel_date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="form-field"><label>Purpose of site visit</label><input name="purpose" required maxlength="2000" placeholder="What was the site visit for?"></div><div class="form-field full"><div class="expense-items-heading"><label>Expense items</label><strong id="expenseTotal">Claim total: ₹0.00</strong></div><div id="expenseItems"></div><button type="button" class="btn btn-small" id="addExpenseItem">+ Add expense item</button></div></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Submit voucher →</button></div></form>`;
}
function showCreate() {
  modal(createModal(), "createModal");
  S.expenseItems = [{ category: "Local travel", description: "", medium: "Taxi / app cab", bill_number: "", amount: "", files: [] }];
  renderExpenseItems();
  $("#addExpenseItem").onclick = () => {
    S.expenseItems.push({ category: "Local travel", description: "", medium: "Taxi / app cab", bill_number: "", amount: "", files: [] });
    renderExpenseItems();
  };
  const projectSelect = $("#projectSelect");
  const origin = $("#voucherOrigin");
  const destination = $("#voucherDestination");
  const updateProjectLocations = () => {
    const selected = S.projects.find((project) => project.id === projectSelect.value);
    $("#projectLocationOptions").innerHTML = (selected?.locations || []).map((location) => `<option value="${esc(location)}"></option>`).join("");
  };
  const updateRouteRequirements = () => {
    const routeRequired = !projectSelect.value;
    origin.required = routeRequired;
    destination.required = routeRequired;
    updateProjectLocations();
  };
  projectSelect.onchange = updateRouteRequirements;
  updateRouteRequirements();
  $("#voucherForm").onsubmit = submitVoucher;
}
function renderExpenseItems() {
  const container = $("#expenseItems");
  if (!container) return;
  container.innerHTML = S.expenseItems
    .map((item, index) => `<div class="expense-item-card" data-expense-index="${index}"><div class="expense-item-top"><strong>Item ${index + 1}</strong><button type="button" class="btn btn-small" data-remove-expense="${index}" ${S.expenseItems.length === 1 ? "disabled" : ""}>Remove</button></div><div class="form-grid"><div class="form-field"><label>Expense type</label><select data-expense-field="category"><option ${item.category === "Local travel" ? "selected" : ""}>Local travel</option><option ${item.category === "Public transport" ? "selected" : ""}>Public transport</option><option ${item.category === "Airfare" ? "selected" : ""}>Airfare</option><option ${item.category === "Personal vehicle / mileage" ? "selected" : ""}>Personal vehicle / mileage</option><option ${item.category === "Tolls and parking" ? "selected" : ""}>Tolls and parking</option><option ${item.category === "Other travel costs" ? "selected" : ""}>Other travel costs</option></select></div><div class="form-field"><label>Travel mode</label><select data-expense-field="medium">${travelMediums.map((medium) => `<option ${item.medium === medium ? "selected" : ""}>${esc(medium)}</option>`).join("")}</select></div><div class="form-field"><label>Amount (₹)</label><input data-expense-field="amount" type="number" min="0.01" step="0.01" required value="${esc(item.amount)}" placeholder="0.00"></div><div class="form-field"><label>Bill number · optional</label><input data-expense-field="bill_number" maxlength="120" value="${esc(item.bill_number)}" placeholder="e.g. INV-1042"></div><div class="form-field full"><label>Description</label><input data-expense-field="description" maxlength="1000" required value="${esc(item.description)}" placeholder="Fare, toll, parking, etc."></div><div class="form-field full"><label>Receipts & proofs for this item</label><div class="upload"><input type="file" data-expense-proof="${index}" multiple accept=".pdf,.png,.jpg,.jpeg"><div class="selected-proof-list">${item.files.map((file, fileIndex) => `<div class="selected-proof"><span>${esc(file.name)}</span><button type="button" class="btn btn-small" data-remove-item-proof="${fileIndex}">Remove</button></div>`).join("")}</div></div></div></div></div>`)
    .join("");
  container.querySelectorAll("[data-expense-field]").forEach((field) => {
    field.addEventListener("input", updateExpenseField);
    field.addEventListener("change", updateExpenseField);
  });
  container.querySelectorAll("[data-remove-expense]").forEach((button) => {
    button.onclick = () => {
      S.expenseItems.splice(Number(button.dataset.removeExpense), 1);
      renderExpenseItems();
    };
  });
  container.querySelectorAll("[data-expense-proof]").forEach((input) => {
    input.onchange = () => {
      const item = S.expenseItems[Number(input.dataset.expenseProof)];
      for (const file of input.files) {
        const duplicate = item.files.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified);
        if (!duplicate) item.files.push(file);
      }
      renderExpenseItems();
    };
  });
  container.querySelectorAll("[data-remove-item-proof]").forEach((button) => {
    button.onclick = () => {
      const itemIndex = Number(button.closest("[data-expense-index]").dataset.expenseIndex);
      S.expenseItems[itemIndex].files.splice(Number(button.dataset.removeItemProof), 1);
      renderExpenseItems();
    };
  });
  updateExpenseTotal();
}
function updateExpenseField(event) {
  const card = event.target.closest("[data-expense-index]");
  const field = event.target.dataset.expenseField;
  if (card && field) S.expenseItems[Number(card.dataset.expenseIndex)][field] = event.target.value;
  updateExpenseTotal();
}
function updateExpenseTotal() {
  const total = $("#expenseTotal");
  if (total) total.textContent = `Claim total: ${money(S.expenseItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0))}`;
}
function renderSelectedProofs() {
  const list = $("#selectedProofs");
  if (!list) return;
  list.innerHTML = S.proofFiles
    .map(
      (file, index) =>
        `<div class="selected-proof"><span>${esc(file.name)}</span><button type="button" class="btn btn-small" data-remove-proof="${index}">Remove</button></div>`,
    )
    .join("");
  list.querySelectorAll("[data-remove-proof]").forEach((button) => {
    button.onclick = () => {
      S.proofFiles.splice(Number(button.dataset.removeProof), 1);
      renderSelectedProofs();
    };
  });
}
async function submitVoucher(e) {
  e.preventDefault();
  let form = e.currentTarget,
    f = new FormData(form);
  try {
    let v = await api("/vouchers", {
      method: "POST",
      body: JSON.stringify({
        project_id: f.get("project_id") || null,
        origin: f.get("origin") || null,
        destination: f.get("destination") || null,
        travel_date: f.get("travel_date"),
        purpose: f.get("purpose"),
        expenses: S.expenseItems.map((item) => ({
          category: item.category,
          description: item.description,
          medium: item.medium,
          bill_number: item.bill_number || null,
          amount: item.amount,
        })),
      }),
    });
    for (let i = 0; i < S.expenseItems.length; i++) {
      const expenseId = v.expenses[i].id;
      for (const file of S.expenseItems[i].files) {
        const fd = new FormData();
        fd.append("file", file);
        await api(`/vouchers/${v.id}/expenses/${expenseId}/attachments`, { method: "POST", body: fd });
      }
    }
    $("#modalRoot").innerHTML = "";
    S.expenseItems = [];
    await load();
    S.view = "vouchers";
    await render();
    toast("Voucher submitted to HR");
  } catch (err) {
    toast(err.message);
  }
}
async function openDetail(id) {
  try {
    let raw = await api(`/vouchers/${encodeURIComponent(id)}`),
      v = normalise(raw);
    modal(detail(v), "detailModal");
    let roleAction = actionFor(v);
    if (roleAction && roleAction[0] === "mark_paid")
      $("[data-action=markPaid]").onclick = () => advance(v, "mark_paid");
    else if (roleAction) {
      let btn = $("[data-action=advance]");
      if (btn) btn.onclick = () => advance(v, roleAction[0]);
    }
    let reject = $("[data-action=reject]");
    if (reject) reject.onclick = () => rejectVoucher(v);
    document.querySelectorAll("[data-preview-file]").forEach((button) => {
      button.onclick = () =>
        openPreview(
          button.dataset.previewFile,
          button.dataset.fileName,
          button.dataset.fileType,
        );
    });
    document.querySelectorAll("[data-expense-proof-upload]").forEach((input) => {
      input.onchange = () => uploadExpenseProofs(v.id, input.dataset.expenseProofUpload, input.files);
    });
  } catch (err) {
    toast(err.message);
  }
}
function openPreview(id, name, contentType) {
  const url = `/api/attachments/${encodeURIComponent(id)}`;
  const preview =
    contentType === "application/pdf"
      ? `<iframe class="pdf-preview" src="${url}" title="${esc(name)}"></iframe>`
      : `<div class="image-preview"><img src="${url}" alt="${esc(name)}"></div>`;
  modal(
    `<section class="modal preview-modal"><div class="modal-head"><h2>${esc(name)}</h2><button type="button" data-close aria-label="Close preview">×</button></div><div class="preview-content">${preview}</div><div class="modal-foot"><a class="btn btn-primary" href="${url}?download=true">Download file</a><button type="button" class="btn" data-close>Close</button></div></section>`,
    "proofPreviewModal",
    true,
  );
}
async function uploadProofs(voucherId, files) {
  try {
    for (const file of files) {
      let fd = new FormData();
      fd.append("file", file);
      await api(`/vouchers/${encodeURIComponent(voucherId)}/attachments`, {
        method: "POST",
        body: fd,
      });
    }
    await openDetail(voucherId);
    toast("Proofs attached");
  } catch (err) {
    toast(err.message);
  }
}
async function uploadExpenseProofs(voucherId, expenseId, files) {
  try {
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      await api(`/vouchers/${encodeURIComponent(voucherId)}/expenses/${encodeURIComponent(expenseId)}/attachments`, { method: "POST", body: fd });
    }
    await openDetail(voucherId);
    toast("Proofs attached to expense item");
  } catch (err) {
    toast(err.message);
  }
}
function detail(v) {
  let action = actionFor(v),
    canReject =
      v.employee_id !== S.user.id &&
      ((S.user.role === "hr" && v.status === "HR review") ||
        (S.user.role === "admin" && v.status === "Admin approval") ||
        (S.user.role === "accounts" && v.status === "Accounts review"));
  const proofMarkup = (f) => `<div class="proof proof-file"><strong>${esc(f.name)}</strong><div class="proof-actions"><button type="button" class="btn btn-small" data-preview-file="${f.id}" data-file-name="${esc(f.name)}" data-file-type="${esc(f.content_type)}">View</button><a class="btn btn-small" href="/api/attachments/${f.id}?download=true">Download</a></div></div>`;
  const attachments = v.proofs.filter((file) => !file.expense_line_id).map(proofMarkup).join("") || '<div class="proof">No unassigned proof files</div>';
  const expenseBreakdown = v.lines.map((item) => `<div class="expense-detail-row"><div class="expense-detail-main"><b>${esc(item[0])}</b><span>${esc(item[1])} · ${esc(item[4] || "Travel mode not recorded")}</span>${item[3] ? `<small>Bill number: ${esc(item[3])}</small>` : ""}<strong>${money(item[2])}</strong></div><div class="expense-detail-proofs">${(item[5] || []).map(proofMarkup).join("") || '<span class="subhead">No proof attached to this item.</span>'}</div>${v.employee_id === S.user.id && v.status === "HR review" ? `<label class="expense-proof-upload">Add proof for this item<input type="file" data-expense-proof-upload="${item[6]}" multiple accept=".pdf,.png,.jpg,.jpeg"></label>` : ""}</div>`).join("");
  let payFields =
    S.user.role === "accounts" &&
    v.status === "Payment processing" &&
    v.employee_id !== S.user.id
      ? `<div class="form-field" style="margin:12px 0"><label>Payment reference</label><input id="payRef" required placeholder="Bank transfer reference"></div><div class="form-field"><label>Payment date</label><input id="payDate" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><button class="btn btn-primary" data-action="markPaid" style="margin-top:10px">Record payment sent →</button>`
      : "";
  return `<div class="modal"><div class="modal-head"><h2>Voucher ${esc(v.id)}</h2>${pill(v.status)}<button data-close>×</button></div><div class="modal-content"><div class="banner">${route(v)} <span style="float:right;font-family:'IBM Plex Mono'">${money(v.total)}</span></div><div class="detail-grid"><div><div class="card"><div class="card-head"><div><h2>Trip & expense details</h2></div><span class="subhead">Submitted by ${esc(v.owner)}</span></div><div class="detail-body"><div class="detail-kv"><div class="kv"><label>Purpose</label><b>${esc(v.purpose)}</b></div><div class="kv"><label>Travel date</label><b>${date(v.date)}</b></div><div class="kv"><label>Travel modes</label><b>${esc(v.mode)}</b></div><div class="kv"><label>Claim total</label><b>${money(v.total)}</b></div></div><h3 style="margin-top:18px">Expense items</h3>${expenseBreakdown}<h3 style="margin-top:18px">Other bills & proofs</h3>${attachments}</div></div><div class="card" style="margin-top:12px"><div class="card-head"><div><h2>Activity</h2></div></div>${v.trail.map((x) => `<div class="activity"><b>${esc(x[0])}</b><small>${esc(x[1])}</small></div>`).join("")}</div></div><div><div class="card"><div class="card-head"><div><h2>Approval progress</h2></div></div>${timeline(v)}</div><div class="card" style="margin-top:12px"><div class="card-head"><div><h2>Next action</h2><p>${action ? esc(action[1]) : "No action is available for your account at this step."}</p></div></div><div class="detail-body">${action && action[0] !== "mark_paid" ? `<button class="btn btn-primary" data-action="advance">${esc(action[1])} →</button>` : ""}${payFields}${canReject ? '<div style="margin-top:9px"><button class="btn btn-small" data-action="reject">Reject voucher</button></div>' : ""}${v.status === "Payment received" ? `<div class="banner" style="margin-top:9px">Payment ref: ${esc(v.payment_reference || "—")} · ${date(v.payment_date)}</div>` : ""}</div></div></div></div></div></div>`;
}
async function advance(v, action) {
  let payload = { action };
  if (action === "mark_paid") {
    payload.payment_reference = $("#payRef").value.trim();
    payload.payment_date = $("#payDate").value;
    if (!payload.payment_reference || !payload.payment_date) {
      toast("Enter payment reference and date");
      return;
    }
  }
  try {
    await api(`/vouchers/${encodeURIComponent(v.id)}/actions`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    $("#modalRoot").innerHTML = "";
    await load();
    toast("Voucher updated");
  } catch (err) {
    toast(err.message);
  }
}
async function rejectVoucher(v) {
  modal(`<form class="modal" id="rejectForm"><div class="modal-head"><h2>Reject voucher ${esc(v.id)}</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="banner">The employee will see this reason with the rejected voucher.</div><div class="form-field"><label>Reason for rejection</label><textarea name="note" required maxlength="2000" placeholder="Explain why this voucher cannot be approved"></textarea></div><div id="rejectError" class="login-error"></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Reject voucher</button></div></form>`, "rejectModal");
  const form = $("#rejectForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const note = new FormData(form).get("note").trim();
    if (!note) return;
    try {
      await api(`/vouchers/${encodeURIComponent(v.id)}/actions`, {
        method: "POST",
        body: JSON.stringify({ action: "reject", note }),
      });
      $("#modalRoot").innerHTML = "";
      await load();
      toast("Voucher rejected");
    } catch (err) {
      $("#rejectError").textContent = err.message;
    }
  };
}
async function createUser(e) {
  e.preventDefault();
  const form = e.currentTarget;
  let f = new FormData(form);
  const username = String(f.get("username") || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".");
  const displayName = String(f.get("display_name") || "").trim();
  const password = String(f.get("password") || "");
  const errorBox = $("#userError");
  errorBox.textContent = "";
  if (!/^[a-z0-9._-]{3,120}$/.test(username)) {
    errorBox.textContent = "Username: use at least 3 letters, numbers, dots, underscores or hyphens.";
    return;
  }
  if (!displayName) {
    errorBox.textContent = "Enter the person's full name.";
    return;
  }
  if (password.length < 8 || password.length > 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errorBox.textContent = "Password: use 8–12 characters with at least one letter and one number.";
    return;
  }
  try {
    await api("/users", {
      method: "POST",
      body: JSON.stringify({
        display_name: displayName,
        username,
        role: f.get("role"),
        password,
      }),
    });
    form.reset();
    await refreshUsers();
    await render();
    toast("User account created");
  } catch (err) {
    errorBox.textContent = err.message;
  }
}
async function editUser(id) {
  const user = S.users.find((item) => item.id === id);
  if (!user) return;
  modal(`<form class="modal" id="editUserForm"><div class="modal-head"><h2>Edit user account</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="banner">Changes apply to this person’s next sign-in. Passwords are managed separately.</div><div class="form-grid"><div class="form-field"><label>Full name</label><input name="display_name" maxlength="200" required value="${esc(user.display_name)}"></div><div class="form-field"><label>Username</label><input name="username" maxlength="120" required value="${esc(user.username)}"><small class="form-hint">Use 3–120 letters, numbers, dots, underscores or hyphens.</small></div><div class="form-field"><label>Role</label><select name="role">${Object.entries(roleNames).map(([key, name]) => `<option value="${key}" ${user.role === key ? "selected" : ""}>${esc(name)}</option>`).join("")}</select></div><div class="form-field"><label>Account status</label><select name="active"><option value="true" ${user.active ? "selected" : ""}>Active</option><option value="false" ${!user.active ? "selected" : ""}>Inactive</option></select></div></div><div id="editUserError" class="login-error" role="alert"></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save changes</button></div></form>`, "editUserModal");
  const form = $("#editUserForm");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const username = String(values.get("username") || "").trim().toLowerCase().replace(/\s+/g, ".");
    const displayName = String(values.get("display_name") || "").trim();
    if (!/^[a-z0-9._-]{3,120}$/.test(username)) {
      $("#editUserError").textContent = "Enter a username with 3–120 letters, numbers, dots, underscores or hyphens.";
      return;
    }
    if (!displayName) {
      $("#editUserError").textContent = "Enter the person's full name.";
      return;
    }
    try {
      await api(`/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          username,
          display_name: displayName,
          role: values.get("role"),
          active: values.get("active") === "true",
        }),
      });
      $("#modalRoot").innerHTML = "";
      await refreshUsers();
      await render();
      toast("User details updated");
    } catch (err) {
      $("#editUserError").textContent = err.message;
    }
  };
}
async function createProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const fields = new FormData(form);
  const name = String(fields.get("name") || "").trim();
  const locations = String(fields.get("locations") || "").split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  const errorBox = $("#projectError");
  errorBox.textContent = "";
  if (!name) {
    errorBox.textContent = "Enter a project name.";
    return;
  }
  try {
    await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name, locations }),
    });
    await refreshProjects();
    await render();
    toast("Project added to voucher options");
  } catch (err) {
    errorBox.textContent = err.message;
  }
}
async function editProject(id) {
  const project = S.projects.find((item) => item.id === id);
  if (!project) return;
  modal(`<form class="modal" id="editProjectForm"><div class="modal-head"><h2>Edit project</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="form-field"><label>Project name</label><input name="name" maxlength="200" required value="${esc(project.name)}"></div><div class="form-field" style="margin-top:14px"><label>Locations · one per line</label><textarea name="locations" rows="6" placeholder="Main Site">${esc((project.locations || []).join("\n"))}</textarea><small class="form-hint">These appear as suggestions on vouchers. Users can still enter another location.</small></div><div id="editProjectError" class="login-error" role="alert"></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save project</button></div></form>`, "editProjectModal");
  const form = $("#editProjectForm");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const locations = String(fields.get("locations") || "").split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
    try {
      await api(`/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: String(fields.get("name") || "").trim(), locations }),
      });
      $("#modalRoot").innerHTML = "";
      await refreshProjects();
      await render();
      toast("Project updated");
    } catch (err) {
      $("#editProjectError").textContent = err.message;
    }
  };
}
async function saveUser(id) {
  let role = $(`[data-user-role="${id}"]`).value;
  try {
    await api(`/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
    await refreshUsers();
    await render();
    toast("User role updated");
  } catch (err) {
    toast(err.message);
  }
}
async function resetPassword(id) {
  modal(`<form class="modal" id="passwordResetForm"><div class="modal-head"><h2>Reset user password</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="banner">Use 8–12 characters with at least one letter and one number.</div><div class="form-field"><label>New password</label><input name="password" type="password" minlength="8" maxlength="12" pattern="(?=.*[A-Za-z])(?=.*[0-9]).{8,12}" autocomplete="new-password" required></div><div class="form-field" style="margin-top:12px"><label>Confirm new password</label><input name="confirm_password" type="password" minlength="8" maxlength="12" autocomplete="new-password" required></div><div id="passwordResetError" class="login-error"></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Save password</button></div></form>`, "passwordResetModal");
  const form = $("#passwordResetForm");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = new FormData(form);
    const password = fields.get("password");
    if (password !== fields.get("confirm_password")) {
      $("#passwordResetError").textContent = "The passwords do not match.";
      return;
    }
    if (password.length < 8 || password.length > 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      $("#passwordResetError").textContent = "Use 8–12 characters, including a letter and a number.";
      return;
    }
    try {
      await api(`/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      $("#modalRoot").innerHTML = "";
      toast("Password reset");
    } catch (err) {
      $("#passwordResetError").textContent = err.message;
    }
  };
}
async function toggleUser(id, active) {
  try {
    await api(`/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !active }),
    });
    await refreshUsers();
    await render();
    toast(active ? "User deactivated" : "User reactivated");
  } catch (err) {
    toast(err.message);
  }
}
boot();
