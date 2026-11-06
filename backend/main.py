"""Standalone RouteBack site: account management, vouchers, approvals and payments."""

from __future__ import annotations

import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Annotated
from urllib.parse import quote
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session, selectinload
from starlette.middleware.sessions import SessionMiddleware

from .database import Base, SessionLocal, db_session, engine
from .models import (
    Attachment,
    ExpenseLine,
    Project,
    Role,
    Status,
    User,
    Voucher,
    VoucherEvent,
    utc_now,
)
from .security import hash_password, verify_password

WEB_ROOT = Path(__file__).resolve().parent.parent
UPLOAD_ROOT = Path(os.getenv("UPLOAD_DIR", str(WEB_ROOT / "private_uploads"))).resolve()
SESSION_SECRET = os.getenv("SESSION_SECRET", "")
if len(SESSION_SECRET) < 32:
    raise RuntimeError(
        "Set SESSION_SECRET to a random value of at least 32 characters before starting RouteBack"
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS project_id "
                "VARCHAR(36) REFERENCES projects(id) ON DELETE SET NULL"
            )
        )
        connection.execute(
            text("ALTER TABLE travel_vouchers ALTER COLUMN origin DROP NOT NULL")
        )
        connection.execute(
            text("ALTER TABLE travel_vouchers ALTER COLUMN destination DROP NOT NULL")
        )
        connection.execute(
            text("ALTER TABLE travel_expense_lines ADD COLUMN IF NOT EXISTS bill_number VARCHAR(120)")
        )
    with SessionLocal() as db:
        if not db.scalar(select(User.id).limit(1)):
            password = os.getenv("INITIAL_ADMIN_PASSWORD", "")
            if (
                len(password) < 8
                or len(password) > 12
                or not any(c.isascii() and c.isalpha() for c in password)
                or not any(c in "0123456789" for c in password)
            ):
                raise RuntimeError(
                    "Set INITIAL_ADMIN_PASSWORD to 8–12 characters with at least one letter and one number"
                )
            admin = User(
                username=os.getenv("INITIAL_ADMIN_USERNAME", "admin").strip().lower(),
                display_name=os.getenv("INITIAL_ADMIN_NAME", "RouteBack Admin").strip(),
                password_hash=hash_password(password),
                role=Role.ADMIN,
                active=True,
            )
            db.add(admin)
            db.commit()
    yield


app = FastAPI(
    title="RouteBack · Site travel reimbursement", version="1.0.0", lifespan=lifespan
)
app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    session_cookie="routeback_session",
    max_age=60 * 60 * 12,
    same_site="lax",
    https_only=os.getenv("COOKIE_HTTPS_ONLY", "0") == "1",
)
allowed_origins = [
    x.strip()
    for x in os.getenv("CORS_ORIGINS", "http://localhost:3080").split(",")
    if x.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)

LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
LOGIN_LIMIT = 10
LOGIN_WINDOW_SECONDS = 15 * 60
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_FILES = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


class LoginIn(BaseModel):
    username: str
    password: str


class UserIn(BaseModel):
    username: str = Field(min_length=3, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=12)
    role: Role = Role.EMPLOYEE

    @field_validator("password")
    @classmethod
    def password_needs_letters_and_numbers(cls, value: str) -> str:
        if not any(c.isascii() and c.isalpha() for c in value) or not any(
            c in "0123456789" for c in value
        ):
            raise ValueError("Password must include at least one letter and one number")
        return value


class UserPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: Role | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8, max_length=12)

    @field_validator("password")
    @classmethod
    def password_needs_letters_and_numbers(cls, value: str | None) -> str | None:
        if value is not None and (
            not any(c.isascii() and c.isalpha() for c in value)
            or not any(c in "0123456789" for c in value)
        ):
            raise ValueError("Password must include at least one letter and one number")
        return value


class ExpenseIn(BaseModel):
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=1000)
    bill_number: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)


class VoucherIn(BaseModel):
    project_id: str | None = None
    origin: str | None = Field(default=None, max_length=240)
    destination: str | None = Field(default=None, max_length=240)
    travel_date: date
    medium: str = Field(min_length=1, max_length=100)
    purpose: str = Field(min_length=1, max_length=2000)
    expenses: list[ExpenseIn] = Field(min_length=1, max_length=60)

    @model_validator(mode="after")
    def require_route_without_project(self) -> "VoucherIn":
        if not self.project_id and (
            not (self.origin or "").strip() or not (self.destination or "").strip()
        ):
            raise ValueError("Select a project or enter both the start and destination")
        return self


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class ActionIn(BaseModel):
    action: str
    note: str | None = Field(default=None, max_length=2000)
    payment_reference: str | None = Field(default=None, max_length=200)
    payment_date: date | None = None


def public_user(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at.isoformat(),
    }


def current_user(request: Request, db: Annotated[Session, Depends(db_session)]) -> User:
    user_id = request.session.get("user_id")
    user = db.get(User, user_id) if user_id else None
    if not user or not user.active:
        request.session.clear()
        raise HTTPException(401, "Please sign in")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_role(*roles: Role):
    def check(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(403, "Your role cannot perform this action")
        return user

    return check


def access_voucher(user: User, voucher: Voucher) -> bool:
    if user.role == Role.ADMIN:
        return True
    if voucher.employee_id == user.id:
        return True
    if user.role == Role.HR and voucher.status == Status.HR_REVIEW:
        return True
    if user.role == Role.ACCOUNTS and voucher.status in {
        Status.ACCOUNTS_REVIEW,
        Status.PAYMENT_PROCESSING,
        Status.PAYMENT_RECEIVED,
    }:
        return True
    return False


def get_voucher(db: Session, voucher_id: str) -> Voucher:
    v = db.scalar(
        select(Voucher)
        .where(Voucher.id == voucher_id)
        .options(
            selectinload(Voucher.employee),
            selectinload(Voucher.project),
            selectinload(Voucher.expenses),
            selectinload(Voucher.events),
            selectinload(Voucher.attachments),
        )
    )
    if not v:
        raise HTTPException(404, "Voucher not found")
    return v


def serialize(v: Voucher) -> dict:
    employee = v.employee.display_name if v.employee else "Employee"
    return {
        "id": v.id,
        "employee_id": v.employee_id,
        "employee_name": employee,
        "project_id": v.project_id,
        "project_name": v.project.name if v.project else None,
        "origin": v.origin,
        "destination": v.destination,
        "travel_date": v.travel_date.isoformat(),
        "medium": v.medium,
        "purpose": v.purpose,
        "amount": str(v.amount),
        "currency": v.currency,
        "status": v.status,
        "payment_reference": v.payment_reference,
        "payment_date": v.payment_date.isoformat() if v.payment_date else None,
        "created_at": v.created_at.isoformat(),
        "expenses": [
            {
                "category": x.category,
                "description": x.description,
                "bill_number": x.bill_number,
                "amount": str(x.amount),
            }
            for x in v.expenses
        ],
        "attachments": [
            {"id": x.id, "name": x.original_name, "content_type": x.content_type}
            for x in v.attachments
        ],
        "events": [
            {
                "actor": x.actor_name,
                "role": x.actor_role,
                "action": x.action,
                "note": x.note,
                "at": x.occurred_at.isoformat(),
            }
            for x in v.events
        ],
    }


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/styles.css", include_in_schema=False)
def stylesheet() -> FileResponse:
    return FileResponse(WEB_ROOT / "styles.css", media_type="text/css")


@app.get("/app.js", include_in_schema=False)
def browser_app() -> FileResponse:
    return FileResponse(WEB_ROOT / "app.js", media_type="text/javascript")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "RouteBack"}


@app.post("/api/auth/login")
def login(
    data: LoginIn, request: Request, db: Annotated[Session, Depends(db_session)]
) -> dict:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    attempts = LOGIN_ATTEMPTS[ip]
    while attempts and now - attempts[0] > LOGIN_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= LOGIN_LIMIT:
        raise HTTPException(429, "Too many sign-in attempts. Try again in 15 minutes.")
    user = db.scalar(select(User).where(User.username == data.username.strip().lower()))
    if (
        not user
        or not user.active
        or not verify_password(data.password, user.password_hash)
    ):
        attempts.append(now)
        raise HTTPException(401, "Username or password is incorrect")
    LOGIN_ATTEMPTS.pop(ip, None)
    request.session.clear()
    request.session["user_id"] = user.id
    return {"user": public_user(user)}


@app.post("/api/auth/logout")
def logout(request: Request) -> dict:
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
def who_am_i(user: CurrentUser) -> dict:
    return {"user": public_user(user)}


@app.get("/api/users")
def list_users(
    user: Annotated[User, Depends(require_role(Role.ADMIN))],
    db: Annotated[Session, Depends(db_session)],
) -> list[dict]:
    return [
        public_user(x)
        for x in db.scalars(
            select(User).order_by(User.display_name, User.username)
        ).all()
    ]


@app.post("/api/users", status_code=201)
def create_user(
    data: UserIn,
    _: Annotated[User, Depends(require_role(Role.ADMIN))],
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    username = data.username.lower()
    if db.scalar(select(User.id).where(User.username == username)):
        raise HTTPException(409, "That username is already in use")
    new_user = User(
        username=username,
        display_name=data.display_name.strip(),
        password_hash=hash_password(data.password),
        role=data.role,
        active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return public_user(new_user)


@app.patch("/api/users/{user_id}")
def update_user(
    user_id: str,
    data: UserPatch,
    actor: Annotated[User, Depends(require_role(Role.ADMIN))],
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == actor.id and data.active is False:
        raise HTTPException(409, "You cannot deactivate your own account")
    if (
        target.role == Role.ADMIN
        and target.active
        and (data.active is False or data.role not in (None, Role.ADMIN))
    ):
        count = len(
            db.scalars(
                select(User.id).where(User.role == Role.ADMIN, User.active.is_(True))
            ).all()
        )
        if count <= 1:
            raise HTTPException(409, "Keep at least one active administrator")
    if data.display_name is not None:
        target.display_name = data.display_name.strip()
    if data.role is not None:
        target.role = data.role
    if data.active is not None:
        target.active = data.active
    if data.password:
        target.password_hash = hash_password(data.password)
    db.commit()
    db.refresh(target)
    return public_user(target)


@app.get("/api/projects")
def list_projects(
    _: CurrentUser, db: Annotated[Session, Depends(db_session)]
) -> list[dict]:
    projects = db.scalars(
        select(Project).where(Project.active.is_(True)).order_by(Project.name)
    ).all()
    return [{"id": p.id, "name": p.name} for p in projects]


@app.post("/api/projects", status_code=201)
def create_project(
    data: ProjectIn,
    _: Annotated[User, Depends(require_role(Role.ADMIN))],
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    name = data.name.strip()
    if not name:
        raise HTTPException(422, "Enter a project name")
    existing = db.scalar(select(Project).where(func.lower(Project.name) == name.lower()))
    if existing:
        raise HTTPException(409, "That project is already in the list")
    project = Project(name=name, active=True)
    db.add(project)
    db.commit()
    db.refresh(project)
    return {"id": project.id, "name": project.name, "active": project.active}


@app.get("/api/vouchers")
def list_vouchers(
    user: CurrentUser, db: Annotated[Session, Depends(db_session)]
) -> dict:
    stmt = (
        select(Voucher)
        .options(
            selectinload(Voucher.employee),
            selectinload(Voucher.project),
            selectinload(Voucher.expenses),
            selectinload(Voucher.events),
            selectinload(Voucher.attachments),
        )
        .order_by(Voucher.created_at.desc())
    )
    if user.role == Role.HR:
        stmt = stmt.where(
            or_(Voucher.employee_id == user.id, Voucher.status == Status.HR_REVIEW)
        )
    elif user.role == Role.ACCOUNTS:
        stmt = stmt.where(
            or_(
                Voucher.employee_id == user.id,
                Voucher.status.in_(
                    [
                        Status.ACCOUNTS_REVIEW,
                        Status.PAYMENT_PROCESSING,
                        Status.PAYMENT_RECEIVED,
                    ]
                ),
            )
        )
    elif user.role != Role.ADMIN:
        stmt = stmt.where(Voucher.employee_id == user.id)
    visible = db.scalars(stmt).unique().all()
    mine = [serialize(v) for v in visible if v.employee_id == user.id]
    queue_statuses = {
        Role.HR: {Status.HR_REVIEW},
        Role.ADMIN: {Status.ADMIN_APPROVAL},
        Role.ACCOUNTS: {
            Status.ACCOUNTS_REVIEW,
            Status.PAYMENT_PROCESSING,
            Status.PAYMENT_RECEIVED,
        },
    }.get(user.role, set())
    queue = [
        serialize(v)
        for v in visible
        if v.employee_id != user.id and v.status in queue_statuses
    ]
    return {"mine": mine, "queue": queue, "user": public_user(user)}


@app.post("/api/vouchers", status_code=201)
def create_voucher(
    data: VoucherIn, user: CurrentUser, db: Annotated[Session, Depends(db_session)]
) -> dict:
    total = sum((x.amount for x in data.expenses), Decimal("0.00"))
    if total <= 0 or total > Decimal("10000000.00"):
        raise HTTPException(422, "Voucher total is outside the allowed range")
    project = None
    if data.project_id:
        project = db.get(Project, data.project_id)
        if not project or not project.active:
            raise HTTPException(422, "Choose an active project")
    voucher = Voucher(
        employee_id=user.id,
        project_id=project.id if project else None,
        origin=data.origin.strip() if data.origin and data.origin.strip() else None,
        destination=data.destination.strip()
        if data.destination and data.destination.strip()
        else None,
        travel_date=data.travel_date,
        medium=data.medium,
        purpose=data.purpose.strip(),
        amount=total,
        currency="INR",
        status=Status.HR_REVIEW,
    )
    voucher.expenses = [
        ExpenseLine(
            category=x.category,
            description=x.description,
            bill_number=x.bill_number,
            amount=x.amount,
        )
        for x in data.expenses
    ]
    voucher.events = [
        VoucherEvent(
            actor_id=user.id,
            actor_name=user.display_name,
            actor_role=user.role,
            action="Submitted",
            occurred_at=utc_now(),
        )
    ]
    db.add(voucher)
    db.commit()
    return serialize(get_voucher(db, voucher.id))


@app.get("/api/vouchers/{voucher_id}")
def voucher_detail(
    voucher_id: str, user: CurrentUser, db: Annotated[Session, Depends(db_session)]
) -> dict:
    v = get_voucher(db, voucher_id)
    if not access_voucher(user, v):
        raise HTTPException(404, "Voucher not found")
    return serialize(v)


@app.post("/api/vouchers/{voucher_id}/attachments", status_code=201)
async def upload_attachment(
    voucher_id: str,
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
    file: UploadFile = File(...),
) -> dict:
    v = get_voucher(db, voucher_id)
    if v.employee_id != user.id or v.status != Status.HR_REVIEW:
        raise HTTPException(
            403, "Only the voucher owner can attach proofs before HR review"
        )
    suffix = Path(file.filename or "").suffix.lower()
    expected_mime = ALLOWED_FILES.get(suffix)
    if not expected_mime or file.content_type != expected_mime:
        raise HTTPException(415, "Attach a PDF, PNG or JPEG proof")
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if not contents or len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Each file must be smaller than 10 MB")
    if (
        (suffix == ".pdf" and not contents.startswith(b"%PDF-"))
        or (suffix == ".png" and not contents.startswith(b"\x89PNG\r\n\x1a\n"))
        or (suffix in {".jpg", ".jpeg"} and not contents.startswith(b"\xff\xd8\xff"))
    ):
        raise HTTPException(415, "The file content does not match its file type")
    safe_name = Path(file.filename or "proof").name[:255]
    key = f"{v.id}/{uuid4().hex}{suffix}"
    path = UPLOAD_ROOT / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    v.attachments.append(
        Attachment(original_name=safe_name, storage_key=key, content_type=expected_mime)
    )
    db.commit()
    return {"name": safe_name, "uploaded": True}


@app.get("/api/attachments/{attachment_id}")
def get_attachment(
    attachment_id: int,
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
    download: bool = False,
) -> FileResponse:
    attachment = db.get(Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "File not found")
    voucher = get_voucher(db, attachment.voucher_id)
    if not access_voucher(user, voucher):
        raise HTTPException(404, "File not found")
    path = (UPLOAD_ROOT / attachment.storage_key).resolve()
    if UPLOAD_ROOT not in path.parents or not path.is_file():
        raise HTTPException(404, "File not found")
    disposition = "attachment" if download else "inline"
    encoded_name = quote(attachment.original_name, safe="")
    return FileResponse(
        path,
        media_type=attachment.content_type,
        headers={"Content-Disposition": f"{disposition}; filename*=UTF-8''{encoded_name}"},
    )


@app.post("/api/vouchers/{voucher_id}/actions")
def voucher_action(
    voucher_id: str,
    data: ActionIn,
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    v = get_voucher(db, voucher_id)
    action = data.action.lower()
    allowed = {
        (Status.HR_REVIEW, Role.HR, "verify"): Status.ADMIN_APPROVAL,
        (Status.ADMIN_APPROVAL, Role.ADMIN, "approve"): Status.ACCOUNTS_REVIEW,
        (Status.ACCOUNTS_REVIEW, Role.ACCOUNTS, "approve"): Status.PAYMENT_PROCESSING,
        (
            Status.PAYMENT_PROCESSING,
            Role.ACCOUNTS,
            "mark_paid",
        ): Status.PAYMENT_RECEIVED,
        (Status.PAYMENT_RECEIVED, Role.EMPLOYEE, "confirm_receipt"): Status.CLOSED,
    }
    if action != "confirm_receipt" and v.employee_id == user.id:
        raise HTTPException(403, "You cannot review or reject your own voucher")
    if action == "reject":
        can_reject = (
            (v.status == Status.HR_REVIEW and user.role == Role.HR)
            or (v.status == Status.ADMIN_APPROVAL and user.role == Role.ADMIN)
            or (v.status == Status.ACCOUNTS_REVIEW and user.role == Role.ACCOUNTS)
        )
        if not can_reject:
            raise HTTPException(
                403, "Only the assigned reviewer can reject at this stage"
            )
        v.status = Status.REJECTED
    else:
        target_status = (
            Status.CLOSED
            if action == "confirm_receipt"
            and v.status == Status.PAYMENT_RECEIVED
            and v.employee_id == user.id
            else allowed.get((v.status, user.role, action))
        )
        if target_status is None:
            raise HTTPException(
                409, "This action is not available to your role at the current stage"
            )
        if action == "mark_paid":
            if not data.payment_reference or not data.payment_date:
                raise HTTPException(422, "Payment reference and date are required")
            v.payment_reference, v.payment_date = (
                data.payment_reference.strip(),
                data.payment_date,
            )
        v.status = target_status
    v.events.append(
        VoucherEvent(
            actor_id=user.id,
            actor_name=user.display_name,
            actor_role=user.role,
            action=action,
            note=data.note,
            occurred_at=utc_now(),
        )
    )
    db.commit()
    return serialize(get_voucher(db, v.id))
