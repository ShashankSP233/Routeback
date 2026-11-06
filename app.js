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
  users: [],
  projects: [],
  proofFiles: [],
  expenseItems: [],
  view: "dashboard",
  query: "",
};
const roleNames = {
  employee: "Employee",
  hr: "HR reviewer",
  admin: "Administrator",
  accounts: "Accounts",
};
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
function dashboard() {
  let pending = S.mine.filter(
      (v) => !["Closed", "Rejected"].includes(v.status),
    ),
    paid = S.mine.filter((v) => v.status === "Closed"),
    sum = S.mine.reduce((a, v) => a + v.total, 0),
    recent = [...S.mine].slice(0, 5),
    next = S.queue[0] || S.mine.find((v) => v.status !== "Closed");
  let actionCount = S.queue.filter((v) => actionFor(v)).length;
  return `${pageHead("SITE TRAVEL CLAIMS", `Welcome, ${esc(S.user.display_name.split(" ")[0])}`, "Your site travel vouchers and reimbursement status.", `<button class="btn btn-primary" id="newVoucher">＋ New voucher</button>`)}<section class="metrics"><div class="metric"><div class="metric-top"><span class="metric-label">MY VOUCHERS</span><span class="metric-icon">▤</span></div><div class="metric-value">${S.mine.length}</div><div class="metric-note">Submitted by you</div></div><div class="metric"><div class="metric-top"><span class="metric-label">IN PROGRESS</span><span class="metric-icon">◷</span></div><div class="metric-value">${pending.length}</div><div class="metric-note">Waiting for a review or payment</div></div><div class="metric"><div class="metric-top"><span class="metric-label">CLOSED</span><span class="metric-icon">✓</span></div><div class="metric-value">${paid.length}</div><div class="metric-note">Payment confirmed by you</div></div><div class="metric"><div class="metric-top"><span class="metric-label">TOTAL CLAIMED</span><span class="metric-icon">₹</span></div><div class="metric-value">${money(sum)}</div><div class="metric-note">Across your vouchers</div></div></section>${
    S.user.role === "employee"
      ? `<section class="content-grid"><div class="card"><div class="card-head"><div><h2>My recent vouchers</h2><p>Your claims and their current status</p></div><button class="text-link" data-view="vouchers">See all →</button></div><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Journey</th><th>Purpose</th><th>Claim</th><th>Status</th><th></th></tr></thead><tbody>${recent.map(row).join("") || `<tr><td colspan="6" class="empty">You haven’t submitted a travel voucher yet.</td></tr>`}</tbody></table></div></div><div class="card"><div class="card-head"><div><h2>Approval journey</h2><p>Every claim follows the same sequence</p></div></div>${timeline(next)}</div></section>`
      : `<section class="content-grid"><div class="card"><div class="card-head"><div><h2>My recent vouchers</h2><p>Your own travel claims</p></div><button class="text-link" data-view="vouchers">See all →</button></div><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Journey</th><th>Purpose</th><th>Claim</th><th>Status</th><th></th></tr></thead><tbody>${recent.map(row).join("") || `<tr><td colspan="6" class="empty">No vouchers submitted by you.</td></tr>`}</tbody></table></div></div><div class="card"><div class="card-head"><div><h2>Review queue</h2><p>${actionCount} voucher${actionCount === 1 ? "" : "s"} ready for your role</p></div><button class="text-link" data-view="approvals">Open queue →</button></div><div class="timeline">${
          S.queue
            .slice(0, 4)
            .map(
              (v) =>
                `<div class="step current"><div class="step-dot">•</div><div><b>${esc(v.id)} · ${esc(v.owner)}</b><small>${esc(v.purpose)} · ${v.status}</small></div></div>`,
            )
            .join("") ||
          `<div class="empty">No vouchers currently need your review.</div>`
        }</div></div></section>`
  }<section class="content-grid" style="margin-top:16px"><div class="card"><div class="card-head"><div><h2>Reimbursement steps</h2><p>From site trip to confirmed payment</p></div></div><div class="timeline"><div class="step"><div class="step-dot">1</div><div><b>Employee submits journey, costs and proofs</b><small>Only the submitting employee can view and confirm their own claim.</small></div></div><div class="step"><div class="step-dot">2</div><div><b>HR verifies the claim</b><small>Travel route, purpose, expense details and supporting bills.</small></div></div><div class="step"><div class="step-dot">3</div><div><b>Admin approval · Vipul Sir</b><small>Approved vouchers move to Accounts.</small></div></div><div class="step"><div class="step-dot">4</div><div><b>Accounts approves and records payment</b><small>Employee confirms receipt to close the voucher.</small></div></div></div></div><div class="card"><div class="card-head"><div><h2>Keep proofs ready</h2><p>Receipts and tickets help speed up review.</p></div></div><div class="detail-body"><div class="banner">Attach receipts, tickets, tolls, parking bills and other site travel proofs with each voucher.</div><button class="btn btn-primary" id="newVoucher2">＋ Create a travel voucher</button></div></div></section>`;
}
function vouchersPage() {
  let rows = S.mine.filter((v) =>
    `${v.id} ${v.to} ${v.purpose} ${v.status}`
      .toLowerCase()
      .includes(S.query.toLowerCase()),
  );
  return `${pageHead("YOUR CLAIMS", "My vouchers", "Only vouchers submitted under your account appear here.", '<button class="btn btn-primary" id="newVoucher">＋ New voucher</button>')}<div class="filters"><input id="search" placeholder="Search vouchers, journeys…" value="${esc(S.query)}"><span class="spacer"></span><span class="subhead">${rows.length} vouchers · INR</span></div><div class="card table-card"><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Journey</th><th>Purpose</th><th>Claim amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map(row).join("") || '<tr><td colspan="6" class="empty">No vouchers match this search.</td></tr>'}</tbody></table></div></div>`;
}
function approvalsPage() {
  return `${pageHead("REVIEW CENTRE", "Approval queue", "Vouchers currently awaiting your role’s review.", "")}<div class="card table-card"><div class="card-head"><div><h2>Vouchers for review</h2><p>${S.queue.length} pending claims in your queue</p></div></div><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Employee & journey</th><th>Purpose</th><th>Claim</th><th>Stage</th><th>Action</th></tr></thead><tbody>${S.queue.map(row).join("") || '<tr><td colspan="6" class="empty">No vouchers are waiting in your queue.</td></tr>'}</tbody></table></div></div>`;
}
function paymentsPage() {
  let rows = [...S.mine, ...S.queue].filter((v) =>
    ["Payment processing", "Payment received", "Closed"].includes(v.status),
  );
  return `${pageHead("REIMBURSEMENTS", "Payments", "Accounts records payment. Each employee confirms their own payment.", "")}<div class="card table-card"><div class="card-head"><div><h2>Payment tracker</h2><p>Payment reference and receipt status</p></div></div><div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Journey</th><th>Purpose</th><th>Amount</th><th>Payment status</th><th></th></tr></thead><tbody>${rows.map(row).join("") || '<tr><td colspan="6" class="empty">No payment records yet.</td></tr>'}</tbody></table></div></div>`;
}
function usersPage() {
  return `${pageHead("ADMINISTRATION", "People & roles", "Create employee accounts and assign HR, Admin or Accounts access.", "")}<section class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>Add a user</h2><p>Each person receives an individual sign-in and sees their own vouchers.</p></div></div><form id="userForm" class="detail-body form-grid" novalidate><div class="form-field"><label>Full name</label><input name="display_name" maxlength="200" placeholder="e.g. Human Resources"></div><div class="form-field"><label>Username</label><input name="username" maxlength="120" autocomplete="off" placeholder="e.g. hr or human.resources"><small class="form-hint">Use letters, numbers, dots, underscores or hyphens. Spaces are converted to dots.</small></div><div class="form-field"><label>Role</label><select name="role"><option value="employee">Employee</option><option value="hr">HR</option><option value="admin">Admin</option><option value="accounts">Accounts</option></select><small class="form-hint">Choose HR, Admin or Accounts when adding a reviewer.</small></div><div class="form-field"><label>Password · 8–12 characters, include letters and numbers</label><input name="password" type="password" maxlength="12" autocomplete="new-password"></div><div class="form-field full"><div id="userError" class="login-error" role="alert"></div><button class="btn btn-primary" type="submit">＋ Create account</button></div></form></section><section class="card"><div class="card-head"><div><h2>All user accounts</h2><p>${S.users.length} total · Each HR and Accounts role can be assigned to multiple people.</p></div></div><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Access</th><th>Update</th></tr></thead><tbody>${S.users
    .map(
      (u) =>
        `<tr><td><b>${esc(u.display_name)}</b></td><td>${esc(u.username)}</td><td><select data-user-role="${u.id}" ${!u.active ? "disabled" : ""}>${Object.entries(
          roleNames,
        )
          .map(
            ([k, n]) =>
              `<option value="${k}" ${u.role === k ? "selected" : ""}>${n}</option>`,
          )
          .join(
            "",
          )}</select></td><td>${u.active ? '<span class="pill pill-closed">Active</span>' : '<span class="pill pill-rejected">Inactive</span>'}</td><td><button class="btn btn-small" data-user-save="${u.id}">Save role</button> <button class="btn btn-small" data-user-reset="${u.id}">Reset password</button> <button class="btn btn-small" data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? "Deactivate" : "Reactivate"}</button></td></tr>`,
    )
    .join("")}</tbody></table></div></section>`;
}
function projectsPage() {
  return `${pageHead("ADMINISTRATION", "Projects", "Manage the selectable project names shown on vouchers.", "")}<div class="banner">Projects are shared labels only. Users are not assigned to projects, and project selection does not change voucher access.</div><section class="card" style="margin-bottom:14px"><div class="card-head"><div><h2>Add a project</h2><p>Employees can select an active project when they submit a voucher.</p></div></div><form id="projectForm" class="detail-body form-grid"><div class="form-field"><label>Project name</label><input name="name" maxlength="200" placeholder="e.g. North Plant Upgrade"></div><div class="form-field" style="align-self:end"><button class="btn btn-primary" type="submit">＋ Add project</button></div><div class="form-field full"><div id="projectError" class="login-error" role="alert"></div></div></form></section><section class="card"><div class="card-head"><div><h2>Selectable projects</h2><p>${S.projects.length} active project${S.projects.length===1?"":"s"}</p></div></div><div class="table-wrap"><table><thead><tr><th>Project name</th><th>Use</th></tr></thead><tbody>${S.projects.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>Voucher selection</td></tr>`).join("")||'<tr><td colspan="2" class="empty">No projects added yet.</td></tr>'}</tbody></table></div></section>`;
}
function miscPage() {
  return `${pageHead("WORKSPACE", "Travel policy", "Guidance for submitting a complete site travel claim.", "")}<div class="content-grid"><div class="card"><div class="card-head"><div><h2>What to include</h2><p>Help reviewers verify your claim.</p></div></div><div class="detail-body"><div class="activity"><b>Trip details</b><small>From and to locations, travel date, mode and site visit purpose.</small></div><div class="activity"><b>Expense breakdown</b><small>Fare, mileage, tolls, parking and other travel costs as separate items.</small></div><div class="activity"><b>Supporting proofs</b><small>Receipts, tickets and other supporting documents.</small></div></div></div><div class="card"><div class="card-head"><div><h2>Approval route</h2><p>Configured for this standalone site.</p></div></div><div class="detail-body"><div class="activity"><b>1 · HR review</b><small>Any active HR user can verify a submitted voucher.</small></div><div class="activity"><b>2 · Admin approval</b><small>Any active Admin can approve after HR verification.</small></div><div class="activity"><b>3 · Accounts review</b><small>Any active Accounts user can approve and record payment.</small></div><div class="activity"><b>4 · Employee confirmation</b><small>Only the voucher owner can confirm receipt and close it.</small></div></div></div></div>`;
}
async function refreshUsers() {
  if (S.user.role === "admin") S.users = await api("/users");
}
async function refreshProjects() {
  S.projects = await api("/projects");
}
async function render() {
  let names = {
    dashboard: "Overview",
    vouchers: "My vouchers",
    approvals: "Approvals",
    payments: "Payments",
    people: "People & roles",
    projects: "Projects",
    policy: "Travel policy",
  };
  $("#crumb").textContent = names[S.view] || "Overview";
  $("#sideName").textContent = S.user.display_name;
  $("#sideRole").textContent = roleNames[S.user.role] || S.user.role;
  $("#sideAvatar").textContent = S.user.display_name
    .split(/\s+/)
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  $("#topAvatar").textContent = $("#sideAvatar").textContent;
  $("#topName").textContent = S.user.display_name;
  $("#usersNav").classList.toggle("hidden", S.user.role !== "admin");
  $("#projectsNav").classList.toggle("hidden", S.user.role !== "admin");
  let canReview = ["hr", "admin", "accounts"].includes(S.user.role);
  $("#approvalsNav").classList.toggle("hidden", !canReview);
  $("#approvalCount").textContent = S.queue.length;
  $("#myCount").textContent = S.mine.length;
  let mobile = [
    ["dashboard", "⌂", "Home"],
    ["vouchers", "▤", "Vouchers"],
  ];
  if (canReview) mobile.push(["approvals", "☷", "Review"]);
  mobile.push(["payments", "₹", "Payments"]);
  if (S.user.role === "admin") {
    mobile.push(["people", "♙", "People"]);
    mobile.push(["projects", "⌂", "Projects"]);
  }
  $("#mobileNav").innerHTML =
    mobile
      .map(
        ([id, icon, label]) =>
          `<button class="mobile-nav-item ${S.view === id ? "active" : ""}" data-view="${id}"><span>${icon}</span>${label}</button>`,
      )
      .join("") +
    `<button class="mobile-nav-item mobile-add" id="mobileNew"><span>＋</span>New</button>`;
  if (S.view === "people" && S.user.role === "admin") await refreshUsers();
  if (S.view === "projects" && S.user.role === "admin") await refreshProjects();
  $("#page").innerHTML =
    S.view === "dashboard"
      ? dashboard()
      : S.view === "vouchers"
        ? vouchersPage()
        : S.view === "approvals"
          ? approvalsPage()
          : S.view === "payments"
            ? paymentsPage()
            : S.view === "people" && S.user.role === "admin"
              ? usersPage()
              : S.view === "projects" && S.user.role === "admin"
                ? projectsPage()
              : miscPage();
  bindPage();
}
function bindPage() {
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === S.view);
    b.onclick = (e) => {
      e.preventDefault();
      S.view = b.dataset.view;
      S.query = "";
      render();
    };
  });
  document
    .querySelectorAll("#newVoucher,#newVoucher2")
    .forEach((b) => (b.onclick = showCreate));
  let mobileNew = $("#mobileNew");
  if (mobileNew) mobileNew.onclick = showCreate;
  document
    .querySelectorAll("[data-open]")
    .forEach((b) => (b.onclick = () => openDetail(b.dataset.open)));
  let search = $("#search");
  if (search)
    search.oninput = () => {
      S.query = search.value;
      let p = search.selectionStart;
      render().then(() => {
        let n = $("#search");
        if (n) {
          n.focus();
          n.setSelectionRange(p, p);
        }
      });
    };
  let form = $("#userForm");
  if (form) form.onsubmit = createUser;
  let projectForm = $("#projectForm");
  if (projectForm) projectForm.onsubmit = createProject;
  document
    .querySelectorAll("[data-user-save]")
    .forEach((b) => (b.onclick = () => saveUser(b.dataset.userSave)));
  document
    .querySelectorAll("[data-user-reset]")
    .forEach((b) => (b.onclick = () => resetPassword(b.dataset.userReset)));
  document
    .querySelectorAll("[data-user-toggle]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          toggleUser(b.dataset.userToggle, b.dataset.active === "true")),
    );
}
function modal(content, id, stack = false) {
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
  return `<form class="modal" id="voucherForm"><div class="modal-head"><h2>New site travel voucher</h2><button type="button" data-close>×</button></div><div class="modal-content"><div class="banner">Select a project or enter the start and destination. Add one or more expense items and proof files for HR review.</div><div class="form-grid"><div class="form-field full"><label>Project · optional</label><select name="project_id" id="projectSelect"><option value="">No project selected</option>${projectOptions}</select><small class="form-hint">Projects are selectable labels only; they do not determine user access.</small></div><div class="form-field"><label>From · required without a project</label><input name="origin" id="voucherOrigin" maxlength="240" placeholder="e.g. Bengaluru office"></div><div class="form-field"><label>To site · required without a project</label><input name="destination" id="voucherDestination" maxlength="240" placeholder="e.g. Hoskote project site"></div><div class="form-field"><label>Travel date</label><input type="date" name="travel_date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="form-field"><label>Travel medium</label><select name="medium"><option>Company cab</option><option>Taxi / app cab</option><option>Personal vehicle</option><option>Auto-rickshaw</option><option>Bus</option><option>Train</option><option>Airplane / commercial flight</option><option>Charter flight</option><option>Helicopter</option><option>Ferry / boat</option><option>Other</option></select></div><div class="form-field full"><label>Purpose of site visit</label><input name="purpose" required maxlength="2000" placeholder="What was the site visit for?"></div><div class="form-field full"><div class="expense-items-heading"><label>Expense items</label><strong id="expenseTotal">Claim total: ₹0.00</strong></div><div id="expenseItems"></div><button type="button" class="btn btn-small" id="addExpenseItem">+ Add expense item</button></div><div class="form-field full"><label>Bills & proofs · PDF, PNG or JPEG, max 10 MB each</label><div class="upload">Add files one or more times; previous selections stay in the list.<input type="file" id="proofsInput" multiple accept=".pdf,.png,.jpg,.jpeg"><div id="selectedProofs" class="selected-proof-list"></div></div></div></div></div><div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Submit voucher →</button></div></form>`;
}
function showCreate() {
  modal(createModal(), "createModal");
  S.expenseItems = [{ category: "Local travel", description: "", bill_number: "", amount: "" }];
  renderExpenseItems();
  $("#addExpenseItem").onclick = () => {
    S.expenseItems.push({ category: "Local travel", description: "", bill_number: "", amount: "" });
    renderExpenseItems();
  };
  S.proofFiles = [];
  renderSelectedProofs();
  $("#proofsInput").onchange = (event) => {
    for (const file of event.target.files) {
      const duplicate = S.proofFiles.some(
        (existing) =>
          existing.name === file.name &&
          existing.size === file.size &&
          existing.lastModified === file.lastModified,
      );
      if (!duplicate) S.proofFiles.push(file);
    }
    event.target.value = "";
    renderSelectedProofs();
  };
  const projectSelect = $("#projectSelect");
  const origin = $("#voucherOrigin");
  const destination = $("#voucherDestination");
  const updateRouteRequirements = () => {
    const routeRequired = !projectSelect.value;
    origin.required = routeRequired;
    destination.required = routeRequired;
  };
  projectSelect.onchange = updateRouteRequirements;
  updateRouteRequirements();
  $("#voucherForm").onsubmit = submitVoucher;
}
function renderExpenseItems() {
  const container = $("#expenseItems");
  if (!container) return;
  container.innerHTML = S.expenseItems
    .map((item, index) => `<div class="expense-item-card" data-expense-index="${index}"><div class="expense-item-top"><strong>Item ${index + 1}</strong><button type="button" class="btn btn-small" data-remove-expense="${index}" ${S.expenseItems.length === 1 ? "disabled" : ""}>Remove</button></div><div class="form-grid"><div class="form-field"><label>Category</label><select data-expense-field="category"><option ${item.category === "Local travel" ? "selected" : ""}>Local travel</option><option ${item.category === "Public transport" ? "selected" : ""}>Public transport</option><option ${item.category === "Airfare" ? "selected" : ""}>Airfare</option><option ${item.category === "Personal vehicle / mileage" ? "selected" : ""}>Personal vehicle / mileage</option><option ${item.category === "Tolls and parking" ? "selected" : ""}>Tolls and parking</option><option ${item.category === "Other travel costs" ? "selected" : ""}>Other travel costs</option></select></div><div class="form-field"><label>Amount (₹)</label><input data-expense-field="amount" type="number" min="0.01" step="0.01" required value="${esc(item.amount)}" placeholder="0.00"></div><div class="form-field"><label>Bill number · optional</label><input data-expense-field="bill_number" maxlength="120" value="${esc(item.bill_number)}" placeholder="e.g. INV-1042"></div><div class="form-field"><label>Description</label><input data-expense-field="description" maxlength="1000" required value="${esc(item.description)}" placeholder="Fare, toll, parking, etc."></div></div></div>`)
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
    f = new FormData(form),
    files = [...S.proofFiles];
  try {
    let v = await api("/vouchers", {
      method: "POST",
      body: JSON.stringify({
        project_id: f.get("project_id") || null,
        origin: f.get("origin") || null,
        destination: f.get("destination") || null,
        travel_date: f.get("travel_date"),
        medium: f.get("medium"),
        purpose: f.get("purpose"),
        expenses: S.expenseItems.map((item) => ({
          category: item.category,
          description: item.description,
          bill_number: item.bill_number || null,
          amount: item.amount,
        })),
      }),
    });
    for (let file of files) {
      let fd = new FormData();
      fd.append("file", file);
      await api(`/vouchers/${v.id}/attachments`, { method: "POST", body: fd });
    }
    $("#modalRoot").innerHTML = "";
    S.proofFiles = [];
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
    let proofInput = $("#extraProofs");
    if (proofInput)
      proofInput.onchange = () => uploadProofs(v.id, proofInput.files);
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
function detail(v) {
  let action = actionFor(v),
    canReject =
      v.employee_id !== S.user.id &&
      ((S.user.role === "hr" && v.status === "HR review") ||
        (S.user.role === "admin" && v.status === "Admin approval") ||
        (S.user.role === "accounts" && v.status === "Accounts review"));
  let attachments =
    v.proofs
      .map(
        (f) => `<div class="proof proof-file"><strong>${esc(f.name)}</strong><div class="proof-actions"><button type="button" class="btn btn-small" data-preview-file="${f.id}" data-file-name="${esc(f.name)}" data-file-type="${esc(f.content_type)}">View</button><a class="btn btn-small" href="/api/attachments/${f.id}?download=true">Download</a></div></div>`,
      )
      .join("") || '<div class="proof">No files attached</div>';
  let extraUpload =
    v.employee_id === S.user.id && v.status === "HR review"
      ? '<div class="proof">Add or retry proof uploads<input id="extraProofs" type="file" multiple accept=".pdf,.png,.jpg,.jpeg"></div>'
      : "";
  let payFields =
    S.user.role === "accounts" &&
    v.status === "Payment processing" &&
    v.employee_id !== S.user.id
      ? `<div class="form-field" style="margin:12px 0"><label>Payment reference</label><input id="payRef" required placeholder="Bank transfer reference"></div><div class="form-field"><label>Payment date</label><input id="payDate" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><button class="btn btn-primary" data-action="markPaid" style="margin-top:10px">Record payment sent →</button>`
      : "";
  return `<div class="modal"><div class="modal-head"><h2>Voucher ${esc(v.id)}</h2>${pill(v.status)}<button data-close>×</button></div><div class="modal-content"><div class="banner">${route(v)} <span style="float:right;font-family:'IBM Plex Mono'">${money(v.total)}</span></div><div class="detail-grid"><div><div class="card"><div class="card-head"><div><h2>Trip & expense details</h2></div><span class="subhead">Submitted by ${esc(v.owner)}</span></div><div class="detail-body"><div class="detail-kv"><div class="kv"><label>Purpose</label><b>${esc(v.purpose)}</b></div><div class="kv"><label>Travel date</label><b>${date(v.date)}</b></div><div class="kv"><label>Travel mode</label><b>${esc(v.mode)}</b></div><div class="kv"><label>Claim total</label><b>${money(v.total)}</b></div></div><h3 style="margin-top:18px">Expense breakdown</h3>${v.lines.map((x) => `<div class="expense-line"><span>${esc(x[0])}</span><span>${esc(x[1])}</span><span>${x[3] ? `Bill: ${esc(x[3])}` : "—"}</span><b>${money(x[2])}</b></div>`).join("")}<h3 style="margin-top:18px">Bills & proofs</h3>${attachments}${extraUpload}</div></div><div class="card" style="margin-top:12px"><div class="card-head"><div><h2>Activity</h2></div></div>${v.trail.map((x) => `<div class="activity"><b>${esc(x[0])}</b><small>${esc(x[1])}</small></div>`).join("")}</div></div><div><div class="card"><div class="card-head"><div><h2>Approval progress</h2></div></div>${timeline(v)}</div><div class="card" style="margin-top:12px"><div class="card-head"><div><h2>Next action</h2><p>${action ? esc(action[1]) : "No action is available for your account at this step."}</p></div></div><div class="detail-body">${action && action[0] !== "mark_paid" ? `<button class="btn btn-primary" data-action="advance">${esc(action[1])} →</button>` : ""}${payFields}${canReject ? '<div style="margin-top:9px"><button class="btn btn-small" data-action="reject">Reject voucher</button></div>' : ""}${v.status === "Payment received" ? `<div class="banner" style="margin-top:9px">Payment ref: ${esc(v.payment_reference || "—")} · ${date(v.payment_date)}</div>` : ""}</div></div></div></div></div></div>`;
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
async function createProject(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const name = String(new FormData(form).get("name") || "").trim();
  const errorBox = $("#projectError");
  errorBox.textContent = "";
  if (!name) {
    errorBox.textContent = "Enter a project name.";
    return;
  }
  try {
    await api("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await refreshProjects();
    await render();
    toast("Project added to voucher options");
  } catch (err) {
    errorBox.textContent = err.message;
  }
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
