# RouteBack — standalone site travel reimbursement

RouteBack is a standalone reimbursement app for trips to a site and back. It uses a Python/FastAPI server and PostgreSQL, serves the browser app and API together at `http://localhost:3080`, and keeps voucher data on the server. It has its own accounts today; its user IDs and role names are kept simple so they can later be mapped to an HR/ERP platform.

## Start locally

Requires Python 3.11 or newer and PostgreSQL.

1. Create a PostgreSQL database named `routeback` (or use another database and update the connection string).
2. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell) and set `ROUTEBACK_DB_URL`, a random `SESSION_SECRET`, and a unique `INITIAL_ADMIN_PASSWORD` of 8–12 characters containing at least one letter and one number.
3. Install dependencies: `python -m pip install -r requirements.txt`.
4. Start the site: `python run_server.py`.
5. Sign in at `http://localhost:3080` with `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD`.

On first startup, RouteBack creates its tables and the initial administrator if the user table is empty. Keep `.env` private. The sample values in `.env.example` are placeholders and must be replaced.

## Roles and access

- **Employee:** submits vouchers, sees only vouchers submitted by their own account, and confirms receipt of their own payment.
- **HR:** reviews submitted vouchers. Multiple active accounts can have the HR role.
- **Admin:** approves after HR and manages user accounts and role assignments. Multiple admin accounts are supported; the final active admin cannot be deactivated or demoted.
- **Accounts:** approves reimbursement, records payment reference and date, and sees the payment queue. Multiple active accounts can have the Accounts role.

Voucher actions are checked on the server. A reviewer cannot review their own voucher. The sequence is HR review → Admin approval → Accounts approval → payment recorded → submitting employee confirms receipt → closed. User accounts can be added, deactivated, reactivated, or reassigned to a role by an Admin. Passwords are stored as scrypt hashes; browser sessions use signed, HTTP-only cookies.

Projects are optional labels on vouchers, managed by Admins. Users are not assigned to projects and project selection does not grant or restrict access. When a project is selected, the origin and destination can be left blank; without a project, both are required. Travel medium options include road, rail, airplane, charter flight, helicopter and ferry/boat.

Proof files accept PDF, PNG and JPEG, with a 10 MB per-file limit. They are stored outside the public web directory and require an authenticated user with voucher access to download.

## Configuration and future hosting

The default bind is `127.0.0.1:3080` for local use. The session cookie is marked Secure for HTTPS requests (including HTTPS forwarded by the local Nginx proxy) and remains usable for office HTTP access. For a server that must accept direct connections from other machines, set `HOST=0.0.0.0`, configure its firewall and network address, and use production secrets and a persistent upload location. `http://localhost:3080` always refers to the device on which the browser is running.

Set `INITIAL_ADMIN_PASSWORD` only for initial setup; after an administrator exists, account management is done from **People & roles**. New users are created by an Admin in the app. User passwords must be 8–12 characters and include at least one letter and one number. `SESSION_SECRET` must be at least 32 characters.

## Project layout

```text
backend/main.py       FastAPI routes, session auth, role checks and workflow
backend/database.py   PostgreSQL engine and session handling
backend/models.py     Users, vouchers, expense lines, attachments and event history
backend/security.py   Password hashing and verification
index.html            Sign-in screen and app shell
styles.css            Responsive app styling
app.js                Browser client; talks to the API (no browser-only voucher store)
run_server.py         Local and hosted server entry point (default port 3080)
private_uploads/      Private proof storage (created when needed)
```
