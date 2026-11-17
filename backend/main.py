"""Standalone RouteBack site: account management, vouchers, approvals and payments."""

from __future__ import annotations

import base64
import csv
import io
import json
import os
import secrets
import time
import zipfile
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from decimal import Decimal
from html import escape
from pathlib import Path
from tempfile import SpooledTemporaryFile
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from starlette.middleware.sessions import SessionMiddleware
from starlette.types import Message, Receive, Scope, Send

from .database import Base, SessionLocal, db_session, engine
from .models import (
    Attachment,
    ExpenseLine,
    Project,
    RegistrationRequest,
    RegistrationStatus,
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


class SchemeAwareSessionMiddleware(SessionMiddleware):
    """Mark session cookies Secure only when the request used HTTPS."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await super().__call__(scope, receive, send)
            return

        secure = scope.get("scheme") == "https"
        cookie_prefix = f"{self.session_cookie}=".encode("ascii")

        async def send_with_scheme_cookie(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = []
                for name, value in message.get("headers", []):
                    if name.lower() == b"set-cookie" and value.startswith(cookie_prefix):
                        parts = [part.strip() for part in value.split(b";")]
                        parts = [part for part in parts if part.lower() != b"secure"]
                        if secure:
                            parts.append(b"Secure")
                        value = b"; ".join(parts)
                    headers.append((name, value))
                message = {**message, "headers": headers}
            await send(message)

        await super().__call__(scope, receive, send_with_scheme_cookie)


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
        connection.execute(
            text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS locations_json TEXT NOT NULL DEFAULT '[]'")
        )
        connection.execute(
            text("ALTER TABLE travel_expense_lines ADD COLUMN IF NOT EXISTS medium VARCHAR(100)")
        )
        connection.execute(
            text(
                "UPDATE travel_expense_lines AS e SET medium = v.medium "
                "FROM travel_vouchers AS v WHERE e.voucher_id = v.id AND e.medium IS NULL"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_voucher_attachments ADD COLUMN IF NOT EXISTS "
                "expense_line_id INTEGER REFERENCES travel_expense_lines(id) ON DELETE CASCADE"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "travel_end_date DATE"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "payment_account VARCHAR(200)"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "payment_method VARCHAR(30)"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "approval_recipient VARCHAR(200)"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "approval_project_code VARCHAR(80)"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_vouchers ADD COLUMN IF NOT EXISTS "
                "approval_note_printed_at TIMESTAMP WITH TIME ZONE"
            )
        )
        connection.execute(
            text(
                "UPDATE travel_vouchers SET travel_end_date = travel_date "
                "WHERE travel_end_date IS NULL"
            )
        )
        connection.execute(
            text("ALTER TABLE travel_vouchers ALTER COLUMN travel_end_date SET NOT NULL")
        )
        connection.execute(
            text(
                "ALTER TABLE travel_expense_lines ADD COLUMN IF NOT EXISTS "
                "is_gst BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_expense_lines ADD COLUMN IF NOT EXISTS "
                "gross_amount NUMERIC(12, 2)"
            )
        )
        connection.execute(
            text(
                "ALTER TABLE travel_expense_lines ADD COLUMN IF NOT EXISTS "
                "gst_amount NUMERIC(12, 2)"
            )
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
    SchemeAwareSessionMiddleware,
    secret_key=SESSION_SECRET,
    session_cookie="routeback_session",
    max_age=60 * 60 * 12,
    same_site="lax",
    https_only=False,
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
REGISTRATION_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
REGISTRATION_LIMIT = 5
REGISTRATION_WINDOW_SECONDS = 60 * 60
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


class RegistrationIn(BaseModel):
    username: str = Field(min_length=3, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$")
    display_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=12)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Enter your full name")
        return value

    @field_validator("password")
    @classmethod
    def password_needs_letters_and_numbers(cls, value: str) -> str:
        if not any(c.isascii() and c.isalpha() for c in value) or not any(
            c in "0123456789" for c in value
        ):
            raise ValueError("Password must include at least one letter and one number")
        return value


class RegistrationDecisionIn(BaseModel):
    action: Literal["approve", "reject"]
    note: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def require_rejection_note(self) -> "RegistrationDecisionIn":
        if self.action == "reject" and not (self.note or "").strip():
            raise ValueError("Enter a reason for rejecting this registration")
        return self


class UserPatch(BaseModel):
    username: str | None = Field(
        default=None, min_length=3, max_length=120, pattern=r"^[a-zA-Z0-9._-]+$"
    )
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
    category: Literal["Airfare", "Public transport", "Food", "Others"]
    description: str = Field(min_length=1, max_length=1000)
    medium: str | None = Field(default=None, max_length=100)
    bill_number: str | None = Field(default=None, max_length=120)
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    is_gst: bool = False

    @model_validator(mode="after")
    def validate_gst_bill_and_food_mode(self) -> "ExpenseIn":
        if self.is_gst and not (self.bill_number or "").strip():
            raise ValueError("Bill number is required when GST is included")
        if self.bill_number is not None:
            self.bill_number = self.bill_number.strip() or None
        if self.category == "Food":
            self.medium = None
        return self


class ExpenseGSTIn(BaseModel):
    expense_id: int = Field(gt=0)
    gross_amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    gst_amount: Decimal = Field(ge=0, max_digits=10, decimal_places=2)


class VoucherIn(BaseModel):
    project_id: str | None = None
    origin: str | None = Field(default=None, max_length=240)
    destination: str | None = Field(default=None, max_length=240)
    travel_date: date
    travel_end_date: date
    medium: str | None = Field(default=None, max_length=100)
    purpose: str = Field(min_length=1, max_length=2000)
    expenses: list[ExpenseIn] = Field(min_length=1, max_length=60)

    @model_validator(mode="after")
    def require_route_without_project(self) -> "VoucherIn":
        if not self.project_id and (
            not (self.origin or "").strip() or not (self.destination or "").strip()
        ):
            raise ValueError("Select a project or enter both the start and destination")
        if self.travel_end_date < self.travel_date:
            raise ValueError("Travel end date must be on or after the start date")
        return self


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    locations: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("locations")
    @classmethod
    def clean_locations(cls, values: list[str]) -> list[str]:
        cleaned = []
        seen = set()
        for value in values:
            location = value.strip()[:240]
            key = location.casefold()
            if location and key not in seen:
                seen.add(key)
                cleaned.append(location)
        return cleaned


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    locations: list[str] | None = Field(default=None, max_length=100)

    @field_validator("locations")
    @classmethod
    def clean_locations(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        cleaned = []
        seen = set()
        for value in values:
            location = value.strip()[:240]
            key = location.casefold()
            if location and key not in seen:
                seen.add(key)
                cleaned.append(location)
        return cleaned


class ActionIn(BaseModel):
    action: str
    note: str | None = Field(default=None, max_length=2000)
    payment_reference: str | None = Field(default=None, max_length=200)
    payment_date: date | None = None
    payment_account: str | None = Field(default=None, max_length=200)
    payment_method: Literal["cash", "account_transfer"] | None = None
    approval_recipient: str | None = Field(default=None, max_length=200)
    approval_project_code: str | None = Field(default=None, max_length=80)
    gst_breakdown: list[ExpenseGSTIn] | None = Field(default=None, max_length=60)


def public_user(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "role": user.role,
        "active": user.active,
        "created_at": user.created_at.isoformat(),
    }


def public_registration(registration: RegistrationRequest) -> dict:
    return {
        "id": registration.id,
        "username": registration.username,
        "display_name": registration.display_name,
        "status": registration.status,
        "submitted_at": registration.submitted_at.isoformat(),
        "review_note": registration.review_note,
    }


def public_project(project: Project) -> dict:
    try:
        locations = json.loads(project.locations_json or "[]")
    except (TypeError, json.JSONDecodeError):
        locations = []
    return {
        "id": project.id,
        "name": project.name,
        "locations": locations if isinstance(locations, list) else [],
        "active": project.active,
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
    if voucher.employee_id == user.id:
        return True
    return user.role in {Role.ADMIN, Role.HR, Role.ACCOUNTS}


def next_voucher_id(db: Session) -> str:
    """Generate a monthly sequence while preventing concurrent duplicate IDs."""
    now = datetime.now().astimezone()
    prefix = f"TRV-{now:%m%y}-"
    lock_key = int(now.strftime("%Y%m"))
    db.execute(
        text("SELECT pg_advisory_xact_lock(CAST(:lock_key AS BIGINT))"),
        {"lock_key": lock_key},
    )
    existing_ids = db.scalars(
        select(Voucher.id).where(Voucher.id.like(f"{prefix}%"))
    ).all()
    last_number = max(
        (
            int(voucher_id[len(prefix) :])
            for voucher_id in existing_ids
            if voucher_id[len(prefix) :].isdigit()
        ),
        default=0,
    )
    return f"{prefix}{last_number + 1:05d}"

def get_voucher(db: Session, voucher_id: str) -> Voucher:
    v = db.scalar(
        select(Voucher)
        .where(Voucher.id == voucher_id)
        .options(
            selectinload(Voucher.employee),
            selectinload(Voucher.project),
            selectinload(Voucher.expenses).selectinload(ExpenseLine.attachments),
            selectinload(Voucher.events),
            selectinload(Voucher.attachments),
        )
    )
    if not v:
        raise HTTPException(404, "Voucher not found")
    return v


def serialize(v: Voucher) -> dict:
    employee = v.employee.display_name if v.employee else "Employee"
    mediums = list(dict.fromkeys(x.medium for x in v.expenses if x.medium))
    return {
        "id": v.id,
        "employee_id": v.employee_id,
        "employee_name": employee,
        "employee_role": v.employee.role if v.employee else None,
        "project_id": v.project_id,
        "project_name": v.project.name if v.project else None,
        "origin": v.origin,
        "destination": v.destination,
        "travel_date": v.travel_date.isoformat(),
        "travel_start_date": v.travel_date.isoformat(),
        "travel_end_date": v.travel_end_date.isoformat(),
        "medium": ", ".join(mediums)
        if mediums
        else "Not applicable"
        if v.expenses and all(x.category == "Food" for x in v.expenses)
        else v.medium,
        "purpose": v.purpose,
        "amount": str(v.amount),
        "currency": v.currency,
        "status": v.status,
        "payment_reference": v.payment_reference,
        "payment_date": v.payment_date.isoformat() if v.payment_date else None,
        "payment_account": v.payment_account,
        "payment_method": v.payment_method,
        "approval_recipient": v.approval_recipient,
        "approval_project_code": v.approval_project_code,
        "approval_note_printed_at": (
            v.approval_note_printed_at.isoformat()
            if v.approval_note_printed_at
            else None
        ),
        "created_at": v.created_at.isoformat(),
        "expenses": [
            {
                "id": x.id,
                "category": x.category,
                "description": x.description,
                "medium": x.medium,
                "bill_number": x.bill_number,
                "amount": str(x.amount),
                "is_gst": x.is_gst,
                "gross_amount": str(x.gross_amount) if x.gross_amount is not None else None,
                "gst_amount": str(x.gst_amount) if x.gst_amount is not None else None,
                "attachments": [
                    {"id": f.id, "name": f.original_name, "content_type": f.content_type}
                    for f in x.attachments
                ],
            }
            for x in v.expenses
        ],
        "attachments": [
            {
                "id": x.id,
                "name": x.original_name,
                "content_type": x.content_type,
                "expense_line_id": x.expense_line_id,
            }
            for x in v.attachments
        ],
        "events": [
            {
                "actor_id": x.actor_id,
                "actor": x.actor_name,
                "role": x.actor_role,
                "action": x.action,
                "note": x.note,
                "at": x.occurred_at.isoformat(),
            }
            for x in v.events
        ],
    }


def approval_signature_requirements(
    voucher: Voucher,
) -> tuple[tuple[Role, str, str], ...]:
    required = (
        (Role.EMPLOYEE, "Submitted", "Employee"),
        (Role.HR, "verify", "HR"),
        (Role.ADMIN, "approve", "Admin"),
        (Role.ACCOUNTS, "approve", "Accounts"),
    )
    if voucher.employee and voucher.employee.role == Role.ADMIN:
        return required[1:]
    return required


def approval_signature_event(
    voucher: Voucher, role: Role, action: str
) -> VoucherEvent | None:
    if action == "Submitted":
        if voucher.employee and voucher.employee.role == Role.ADMIN:
            return None
        return next(
            (
                event
                for event in voucher.events
                if event.actor_id == voucher.employee_id and event.action == action
            ),
            None,
        )
    return next(
        (
            event
            for event in voucher.events
            if event.actor_role == role and event.action == action
        ),
        None,
    )


def approval_project_reference(voucher: Voucher) -> str | None:
    return (
        voucher.approval_project_code
        or (voucher.project.name if voucher.project else None)
        or voucher.origin
    )


def require_approval_signatures(v: Voucher) -> None:
    for role, approval_action, label in approval_signature_requirements(v):
        event = approval_signature_event(v, role, approval_action)
        if not event or not event.actor_name.strip():
            raise HTTPException(
                409,
                f"{label} approval name is missing; complete the approval stage before printing",
            )


def require_printed_note(v: Voucher) -> None:
    if not v.approval_note_printed_at:
        raise HTTPException(409, "Print the approval note during Printing before downloading it")
    if not (
        v.approval_recipient
        and v.payment_account
        and v.payment_method
        and (not v.project_id or approval_project_reference(v))
    ):
        raise HTTPException(409, "Complete the approval-note details before downloading it")
    require_approval_signatures(v)


def approval_note_html(v: Voucher) -> str:
    def value(text: object | None) -> str:
        return escape(str(text)) if text else "—"

    logo_data = base64.b64encode((WEB_ROOT / "logo.png").read_bytes()).decode("ascii")
    company_name = "DHARTI"

    def amount(number: Decimal) -> str:
        return f"₹{number:,.2f}"

    def amount_in_words(number: Decimal) -> str:
        words = [
            "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
            "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
            "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
        ]
        tens = [
            "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
            "Eighty", "Ninety",
        ]

        def under_thousand(value: int) -> str:
            if value < 20:
                return words[value]
            if value < 100:
                return tens[value // 10] + (
                    f" {words[value % 10]}" if value % 10 else ""
                )
            result = f"{words[value // 100]} Hundred"
            if value % 100:
                result += f" {under_thousand(value % 100)}"
            return result

        paise_total = int(number * 100)
        rupees, paise = divmod(paise_total, 100)
        groups = (
            (rupees // 10_000_000, "Crore"),
            ((rupees % 10_000_000) // 100_000, "Lakh"),
            ((rupees % 100_000) // 1_000, "Thousand"),
            ((rupees % 1_000) // 100, "Hundred"),
        )
        parts = [
            f"{under_thousand(value)} {label}"
            for value, label in groups
            if value
        ]
        if rupees % 100:
            parts.append(under_thousand(rupees % 100))
        result = " ".join(parts) or "Zero"
        if paise:
            result += f" and {under_thousand(paise)} Paise"
        return f"{result} Rupees Only"

    location = " → ".join(part for part in (v.origin, v.destination) if part)
    project = v.project.name if v.project else v.origin or "Site travel"
    project_code = approval_project_reference(v) or "—"
    employee_name = (
        v.employee.display_name
        if v.employee and v.employee.role != Role.ADMIN
        else None
    )
    note_date = v.approval_note_printed_at or utc_now()
    signature_events = [
        (role, action, title, approval_signature_event(v, role, action))
        for role, action, title in approval_signature_requirements(v)
    ]
    note_ready = bool(
        v.approval_recipient
        and v.payment_account
        and v.payment_method
        and (not v.project_id or approval_project_reference(v))
        and all(
            event and event.actor_name.strip()
            for _, _, _, event in signature_events
        )
    )
    draft_notice = (
        ""
        if note_ready
        else "<p class=\"draft\">DRAFT — approval details or signatures are incomplete. "
        "Do not use as a final payment approval.</p>"
    )
    travel_dates = v.travel_date.strftime("%d %b %Y")
    if v.travel_end_date != v.travel_date:
        travel_dates += f" – {v.travel_end_date.strftime('%d %b %Y')}"
    signature_titles = {
        "Employee": "Employee",
        "HR": "HR Reviewer",
        "Admin": "Admin Approver",
        "Accounts": "Accounts Reviewer",
    }
    signature_html = []
    for _, _, label, event in signature_events:
        title = signature_titles[label]
        signed_date = (
            f" · {event.occurred_at:%d %b %Y}" if event else ""
        )
        verification_mark = (
            '<b class="verified-mark">Digitally verified</b>'
            if event
            else '<b class="pending-mark">Pending approval</b>'
        )
        signature_html.append(
            f"<div class=\"signature digital\">{verification_mark}"
            f"<strong>{value(event.actor_name if event else None)}</strong>"
            f"<small>{title}{signed_date}</small></div>"
        )
    physical_signature_html = (
        [
            "<div class=\"signature physical\"><span></span>"
            "<strong>Managing Director (MD Sir)</strong>"
            "<small>Physical signature</small></div>",
            "<div class=\"signature physical\"><span></span>"
            "<strong>Hon. Chairman</strong><small>Physical signature</small></div>",
        ]
    )
    expense_rows = []
    for index, expense in enumerate(v.expenses, 1):
        files = [
            attachment.original_name
            for attachment in v.attachments
            if attachment.expense_line_id == expense.id
        ]
        bill_names = ", ".join(files) or "No bill attached"
        expense_rows.append(
            "<tr>"
            f"<td>{index}</td><td>{value(v.id)}</td><td>{travel_dates}</td>"
            f"<td>{value(employee_name)}</td>"
            f"<td>{value(project)}</td><td>{value(expense.category)}</td>"
            f"<td>{value(expense.description)}</td>"
            f"<td>{value(expense.bill_number)}</td>"
            f"<td>{'Yes' if files else 'No'} · {value(bill_names)}</td>"
            f"<td class=\"amount\">{amount(expense.amount)}</td></tr>"
        )
    payment_method = (
        "Account transfer"
        if v.payment_method == "account_transfer"
        else "Cash" if v.payment_method == "cash" else "Not recorded"
    )
    project_reference = approval_project_reference(v)
    project_code = project_reference or "—"
    project_code_markup = (
        f"<small class=\"project-code\">{value(project_code)}</small>"
        if project_reference and project_reference.casefold() != project.casefold()
        else ""
    )
    from_row = (
        f"<tr><td>From</td><td colspan=\"3\">{value(employee_name)}</td></tr>"
        if employee_name
        else ""
    )
    payment_to = (
        f"<p><strong>Payment To:</strong> {value(employee_name)}</p>"
        if employee_name
        else ""
    )
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        f"<title>Approval note {value(v.id)}</title><style>"
        "@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box}"
        "body{font:11px/1.45 Arial,sans-serif;color:#202b30;margin:0}"
        ".page{width:100%}.approval-page{min-height:267mm;display:flex;flex-direction:column}"
        ".note-header{position:relative;text-align:center;margin-bottom:8px}"
        ".brand-lockup{display:flex;align-items:center;justify-content:center;gap:8px;margin:0 auto 4px}"
        ".brand-mark{width:55px;height:29px;overflow:hidden;flex:0 0 auto}"
        ".note-logo{display:block;width:55px;height:auto;margin:0}"
        ".company-name{font-size:18px;font-weight:bold;letter-spacing:1.2px;color:#b11f45}"
        ".serial{position:absolute;right:0;top:3px;font-size:7px}"
        "h1{text-align:center;font-size:19px;letter-spacing:1px;margin:0 0 12px}"
        "table{width:100%;border-collapse:collapse;margin:9px 0}"
        ".meta td{border:1px solid #89969b;padding:5px 7px;vertical-align:top}"
        ".meta td:first-child,.meta td:nth-child(3){font-weight:bold;white-space:nowrap;width:75px}"
        ".meta td:nth-child(2){width:38%}.section-title{font-size:12px;font-weight:bold;margin:13px 0 6px}"
        ".fund th,.fund td{border:1px solid #89969b;padding:5px;text-align:left;vertical-align:top}"
        ".fund th{background:#edf1f2}.fund th:first-child{width:48px}"
        ".project-code{display:block;font-size:9px;color:#526168}"
        ".fund-total{width:42%;margin:0 0 7px auto;border-collapse:collapse}"
        ".fund-total td{border:1px solid #89969b;padding:5px 7px}"
        ".fund-total td:first-child{font-weight:bold}.fund-total td:last-child{text-align:right;font-weight:bold;white-space:nowrap}"
        ".words{margin:8px 0}.purpose{border:1px solid #89969b;padding:8px;min-height:42px;margin:9px 0}"
        ".payment{margin:8px 0}.payment p{margin:3px 0}.amount{text-align:right;white-space:nowrap}"
        ".digital-section{margin-top:12px}.digital-section h2{font-size:12px;margin:0 0 6px;text-transform:uppercase}"
        ".digital-signatures{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 10px}"
        ".digital-signatures .signature{min-height:54px;border:1px solid #89969b;padding:6px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:3px;text-align:center;overflow-wrap:anywhere}"
        ".digital-signatures .signature:last-child:nth-child(odd){grid-column:1/-1;width:calc(50% - 5px);justify-self:center}"
        ".signature strong{font-size:10px}.signature small{font-size:9px;color:#526168}"
        ".verified-mark,.pending-mark{align-self:center;border-radius:4px;padding:2px 5px;font-size:8px;text-transform:uppercase}"
        ".verified-mark{background:#e4f2e8;color:#24623b}.pending-mark{background:#fff0d6;color:#805500}"
        ".physical-signatures{display:grid;grid-template-columns:repeat(2,1fr);gap:30px;margin-top:auto;padding-top:34mm}"
        ".physical-signatures .signature{min-height:45px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;text-align:center;padding:0 15mm}"
        ".signature.physical span{width:100%;border-top:1px solid #38484e;margin-bottom:5px}"
        ".annexure-page{break-before:page;page-break-before:always}"
        ".annexure{width:100%;border-collapse:collapse}.annexure th,.annexure td{border:1px solid #89969b;padding:5px;font-size:8px;text-align:left;vertical-align:top}"
        ".annexure th{background:#edf1f2}.annexure td:nth-child(7){min-width:150px;overflow-wrap:anywhere}"
        ".draft{padding:9px;background:#fff0d6;color:#805500;font-weight:bold;text-align:center}"
        "@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}"
        "</style></head><body><main class=\"page\"><section class=\"approval-page\">"
        f"{draft_notice}<header class=\"note-header\"><div class=\"brand-lockup\"><span class=\"brand-mark\">"
        f"<img class=\"note-logo\" src=\"data:image/png;base64,{logo_data}\" alt=\"{company_name} logo\"></span>"
        f"<span class=\"company-name\">{company_name}</span></div>"
        f"<span class=\"serial\">SR. NO. {value(v.id)}</span>"
        "<h1>APPROVAL NOTE</h1></header><table class=\"meta\">"
        f"<tr><td>Request No.</td><td>{value(v.id)}</td><td>Date</td>"
        f"<td>{note_date:%d %b %Y}</td></tr>"
        f"<tr><td>To</td><td colspan=\"3\">{value(v.approval_recipient)}</td></tr>"
        f"{from_row}"
        f"<tr><td>Subject</td><td colspan=\"3\">{value(v.purpose)} · {travel_dates}</td></tr>"
        "</table><h2 class=\"section-title\">Project-wise Fund Requirement</h2>"
        "<table class=\"fund\"><thead><tr><th>Sr. No.</th><th>Project</th>"
        "<th class=\"amount\">Requested Amount (Rs.)</th></tr></thead><tbody><tr>"
        f"<td>1</td><td><strong>{value(project)}</strong>{project_code_markup}</td>"
        f"<td class=\"amount\">{amount(v.amount)}</td></tr></tbody></table>"
        "<table class=\"fund-total\"><tbody><tr><td>Total Request Amount</td>"
        f"<td>{amount(v.amount)}</td></tr></tbody></table>"
        f"<p><strong>Amount in Words:</strong> {amount_in_words(v.amount)}</p>"
        f"<div class=\"purpose\"><strong>Purpose:</strong> {value(v.purpose)} · {value(location or project)}</div>"
        f"<div class=\"payment\">{payment_to}"
        f"<p><strong>Paid From:</strong> {value(v.payment_account)}</p>"
        f"<p><strong>Mode:</strong> {payment_method}</p></div>"
        "<section class=\"digital-section\"><h2>Digital Verification</h2>"
        "<div class=\"digital-signatures\">"
        f"{''.join(signature_html)}</div></section><div class=\"physical-signatures\">"
        f"{''.join(physical_signature_html)}</div></section>"
        "<section class=\"annexure-page\"><h1>ANNEXURE</h1>"
        f"<p><strong>Voucher:</strong> {value(v.id)} · <strong>Project:</strong> {value(project)} · "
        f"<strong>Project name / code:</strong> {value(project_code)}</p>"
        "<table class=\"annexure\"><thead><tr><th>Sr.</th><th>Voucher No.</th>"
        "<th>Travel Date(s)</th><th>Created By</th><th>Site / Location</th>"
        "<th>Category</th><th>Details</th><th>Bill No.</th><th>Bill</th>"
        "<th>Amount</th></tr></thead><tbody>"
        f"{''.join(expense_rows)}</tbody><tfoot><tr>"
        f"<td colspan=\"9\"><strong>Total</strong></td><td class=\"amount\">"
        f"<strong>{amount(v.amount)}</strong></td></tr></tfoot></table>"
        "</section></main></body></html>"
    )


@app.get("/", include_in_schema=False)
def home() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/styles.css", include_in_schema=False)
def stylesheet() -> FileResponse:
    return FileResponse(WEB_ROOT / "styles.css", media_type="text/css")


@app.get("/logo.png", include_in_schema=False)
def logo() -> FileResponse:
    return FileResponse(WEB_ROOT / "logo.png", media_type="image/png")


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


@app.post("/api/auth/register", status_code=202)
def register(
    data: RegistrationIn,
    request: Request,
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    attempts = REGISTRATION_ATTEMPTS[ip]
    while attempts and now - attempts[0] > REGISTRATION_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= REGISTRATION_LIMIT:
        raise HTTPException(429, "Too many registration attempts. Try again in one hour.")
    attempts.append(now)

    username = data.username.strip().lower()
    if db.scalar(select(User.id).where(User.username == username)):
        raise HTTPException(409, "That username is already in use")

    registration = db.scalar(
        select(RegistrationRequest).where(RegistrationRequest.username == username)
    )
    if registration and registration.status == RegistrationStatus.PENDING:
        raise HTTPException(409, "A registration for that username is already awaiting HR review")

    if registration:
        registration.display_name = data.display_name
        registration.password_hash = hash_password(data.password)
        registration.status = RegistrationStatus.PENDING
        registration.submitted_at = utc_now()
        registration.reviewed_at = None
        registration.reviewed_by = None
        registration.review_note = None
    else:
        registration = RegistrationRequest(
            username=username,
            display_name=data.display_name,
            password_hash=hash_password(data.password),
            status=RegistrationStatus.PENDING,
        )
        db.add(registration)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "A registration for that username already exists") from exc
    return {"message": "Registration submitted. HR must approve it before you can sign in."}


@app.get("/api/registrations")
def list_registrations(
    _: Annotated[User, Depends(require_role(Role.HR))],
    db: Annotated[Session, Depends(db_session)],
) -> list[dict]:
    registrations = db.scalars(
        select(RegistrationRequest)
        .where(RegistrationRequest.status == RegistrationStatus.PENDING)
        .order_by(RegistrationRequest.submitted_at, RegistrationRequest.id)
    ).all()
    return [public_registration(registration) for registration in registrations]


@app.post("/api/registrations/{registration_id}/review")
def review_registration(
    registration_id: str,
    data: RegistrationDecisionIn,
    actor: Annotated[User, Depends(require_role(Role.HR))],
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    registration = db.get(RegistrationRequest, registration_id)
    if not registration:
        raise HTTPException(404, "Registration request not found")
    if registration.status != RegistrationStatus.PENDING:
        raise HTTPException(409, "This registration request has already been reviewed")

    new_user = None
    if data.action == "approve":
        if db.scalar(select(User.id).where(User.username == registration.username)):
            raise HTTPException(409, "That username is already in use")
        if not registration.password_hash:
            raise HTTPException(409, "This registration request cannot be approved")
        new_user = User(
            username=registration.username,
            display_name=registration.display_name,
            password_hash=registration.password_hash,
            role=Role.EMPLOYEE,
            active=True,
        )
        db.add(new_user)
        registration.status = RegistrationStatus.APPROVED
        registration.password_hash = None
    else:
        registration.status = RegistrationStatus.REJECTED
        registration.password_hash = None

    registration.reviewed_at = utc_now()
    registration.reviewed_by = actor.id
    registration.review_note = (data.note or "").strip() or None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "That username is already in use") from exc
    db.refresh(registration)
    if new_user:
        db.refresh(new_user)
    return {
        "registration": public_registration(registration),
        "user": public_user(new_user) if new_user else None,
    }


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
    if db.scalar(
        select(RegistrationRequest.id).where(
            RegistrationRequest.username == username,
            RegistrationRequest.status == RegistrationStatus.PENDING,
        )
    ):
        raise HTTPException(409, "That username has a pending registration")
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
    if data.username is not None:
        username = data.username.strip().lower()
        duplicate = db.scalar(
            select(User.id).where(User.username == username, User.id != target.id)
        )
        if duplicate:
            raise HTTPException(409, "That username is already in use")
        pending_registration = db.scalar(
            select(RegistrationRequest.id).where(
                RegistrationRequest.username == username,
                RegistrationRequest.status == RegistrationStatus.PENDING,
            )
        )
        if pending_registration:
            raise HTTPException(409, "That username has a pending registration")
        target.username = username
    if data.display_name is not None:
        display_name = data.display_name.strip()
        if not display_name:
            raise HTTPException(422, "Enter the person's full name")
        target.display_name = display_name
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
    return [public_project(p) for p in projects]


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
    project = Project(
        name=name, active=True, locations_json=json.dumps(data.locations, ensure_ascii=False)
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return public_project(project)


@app.patch("/api/projects/{project_id}")
def update_project(
    project_id: str,
    data: ProjectPatch,
    _: Annotated[User, Depends(require_role(Role.ADMIN))],
    db: Annotated[Session, Depends(db_session)],
) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    if data.name is not None:
        name = data.name.strip()
        if not name:
            raise HTTPException(422, "Enter a project name")
        duplicate = db.scalar(
            select(Project.id).where(
                func.lower(Project.name) == name.lower(), Project.id != project.id
            )
        )
        if duplicate:
            raise HTTPException(409, "That project name is already in use")
        project.name = name
    if data.locations is not None:
        project.locations_json = json.dumps(data.locations, ensure_ascii=False)
    db.commit()
    db.refresh(project)
    return public_project(project)


@app.get("/api/vouchers")
def list_vouchers(
    user: CurrentUser, db: Annotated[Session, Depends(db_session)]
) -> dict:
    stmt = (
        select(Voucher)
        .options(
            selectinload(Voucher.employee),
            selectinload(Voucher.project),
            selectinload(Voucher.expenses).selectinload(ExpenseLine.attachments),
            selectinload(Voucher.events),
            selectinload(Voucher.attachments),
        )
        .order_by(Voucher.created_at.desc())
    )
    if user.role not in {Role.ADMIN, Role.HR, Role.ACCOUNTS}:
        stmt = stmt.where(Voucher.employee_id == user.id)
    visible = db.scalars(stmt).unique().all()
    mine = [serialize(v) for v in visible if v.employee_id == user.id]
    queue_statuses = {
        Role.HR: {Status.HR_REVIEW},
        Role.ADMIN: {Status.ADMIN_APPROVAL},
        Role.ACCOUNTS: {
            Status.ACCOUNTS_REVIEW,
            Status.PRINTING,
            Status.PAYMENT_PROCESSING,
        },
    }.get(user.role, set())
    review_status = {
        Role.HR: Status.HR_REVIEW,
        Role.ADMIN: Status.ADMIN_APPROVAL,
        Role.ACCOUNTS: Status.ACCOUNTS_REVIEW,
    }.get(user.role)
    queue = [
        serialize(v)
        for v in visible
        if v.status in queue_statuses
        and (v.employee_id != user.id or v.status == review_status)
    ]
    all_vouchers = (
        [serialize(v) for v in visible]
        if user.role in {Role.ADMIN, Role.HR, Role.ACCOUNTS}
        else []
    )
    return {
        "mine": mine,
        "queue": queue,
        "all_vouchers": all_vouchers,
        "user": public_user(user),
    }


@app.get("/api/reports/vouchers.csv")
def export_vouchers_csv(
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    status: str | None = None,
    project_id: str | None = None,
    employee_id: str | None = None,
    search: str | None = None,
) -> Response:
    stmt = (
        select(Voucher)
        .join(Voucher.employee)
        .outerjoin(Voucher.project)
        .options(
            selectinload(Voucher.employee),
            selectinload(Voucher.project),
            selectinload(Voucher.expenses).selectinload(ExpenseLine.attachments),
            selectinload(Voucher.attachments),
        )
        .order_by(Voucher.created_at.desc(), Voucher.id)
    )
    if user.role not in {Role.ADMIN, Role.HR, Role.ACCOUNTS}:
        stmt = stmt.where(Voucher.employee_id == user.id)
    if from_date:
        stmt = stmt.where(Voucher.travel_end_date >= from_date)
    if to_date:
        stmt = stmt.where(Voucher.travel_date <= to_date)
    if status:
        stmt = stmt.where(Voucher.status == status)
    if project_id:
        stmt = stmt.where(Voucher.project_id == project_id)
    if employee_id and user.role in {Role.ADMIN, Role.HR, Role.ACCOUNTS}:
        stmt = stmt.where(Voucher.employee_id == employee_id)
    if search and search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                Voucher.id.ilike(term),
                Voucher.purpose.ilike(term),
                Voucher.origin.ilike(term),
                Voucher.destination.ilike(term),
                User.display_name.ilike(term),
                Project.name.ilike(term),
                Voucher.expenses.any(
                    or_(
                        ExpenseLine.description.ilike(term),
                        ExpenseLine.bill_number.ilike(term),
                        ExpenseLine.category.ilike(term),
                        ExpenseLine.medium.ilike(term),
                    )
                ),
            )
        )
    vouchers = db.scalars(stmt).unique().all()
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(
        [
            "Voucher", "Employee", "Username", "Project", "Location", "Travel from",
            "Travel to",
            "Travel medium", "Purpose", "Expense category", "Expense description",
            "Bill number", "Gross amount (before GST)", "GST amount", "Total amount",
            "GST included",
            "Voucher total", "Status", "Payment reference", "Payment date", "Proof files",
        ]
    )

    def cell(value: object) -> str:
        text_value = str(value if value is not None else "")
        if text_value.startswith(("=", "+", "-", "@", "\t", "\r")):
            text_value = "'" + text_value
        return text_value

    for voucher in vouchers:
        expenses = voucher.expenses or [None]
        for expense in expenses:
            files = (
                [f.original_name for f in expense.attachments]
                if expense
                else []
            )
            if expense:
                files.extend(
                    f.original_name
                    for f in voucher.attachments
                    if f.expense_line_id == expense.id
                )
            writer.writerow(
                [
                    cell(voucher.id),
                    cell(voucher.employee.display_name if voucher.employee else ""),
                    cell(voucher.employee.username if voucher.employee else ""),
                    cell(voucher.project.name if voucher.project else ""),
                    cell(" → ".join(x for x in [voucher.origin, voucher.destination] if x)),
                    cell(voucher.travel_date.isoformat()),
                    cell(voucher.travel_end_date.isoformat()),
                    cell(expense.medium if expense else voucher.medium),
                    cell(voucher.purpose),
                    cell(expense.category if expense else ""),
                    cell(expense.description if expense else ""),
                    cell(expense.bill_number if expense else ""),
                    cell(
                        expense.gross_amount
                        if expense and expense.is_gst
                        else ""
                    ),
                    cell(
                        expense.gst_amount
                        if expense and expense.is_gst
                        else ""
                    ),
                    cell(expense.amount if expense else ""),
                    cell("Yes" if expense and expense.is_gst else "No" if expense else ""),
                    cell(voucher.amount),
                    cell(voucher.status),
                    cell(voucher.payment_reference),
                    cell(voucher.payment_date.isoformat() if voucher.payment_date else ""),
                    cell("; ".join(dict.fromkeys(files))),
                ]
            )
    filename = f"routeback-vouchers-{date.today():%Y%m%d}.csv"
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
        id=next_voucher_id(db),
        employee_id=user.id,
        project_id=project.id if project else None,
        origin=data.origin.strip() if data.origin and data.origin.strip() else None,
        destination=data.destination.strip()
        if data.destination and data.destination.strip()
        else None,
        travel_date=data.travel_date,
        travel_end_date=data.travel_end_date,
        medium=data.medium
        or next((expense.medium for expense in data.expenses if expense.medium), None)
        or "Other",
        purpose=data.purpose.strip(),
        amount=total,
        currency="INR",
        status=Status.HR_REVIEW,
    )
    voucher.expenses = [
        ExpenseLine(
            category=x.category,
            description=x.description,
            medium=None
            if x.category == "Food"
            else x.medium or data.medium or "Other",
            bill_number=x.bill_number,
            amount=x.amount,
            is_gst=x.is_gst,
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
    return await store_attachment(v, file, db)


@app.post("/api/vouchers/{voucher_id}/expenses/{expense_line_id}/attachments", status_code=201)
async def upload_expense_attachment(
    voucher_id: str,
    expense_line_id: int,
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
    file: UploadFile = File(...),
) -> dict:
    v = get_voucher(db, voucher_id)
    if v.employee_id != user.id or v.status != Status.HR_REVIEW:
        raise HTTPException(403, "Only the voucher owner can attach proofs before HR review")
    expense = next((item for item in v.expenses if item.id == expense_line_id), None)
    if not expense:
        raise HTTPException(404, "Expense item not found")
    return await store_attachment(v, file, db, expense)


async def store_attachment(
    voucher: Voucher,
    file: UploadFile,
    db: Session,
    expense: ExpenseLine | None = None,
) -> dict:
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
    key = f"{voucher.id}/{uuid4().hex}{suffix}"
    path = UPLOAD_ROOT / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents)
    voucher.attachments.append(
        Attachment(
            original_name=safe_name,
            storage_key=key,
            content_type=expected_mime,
            expense_line=expense,
        )
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


@app.get("/api/vouchers/{voucher_id}/bundle")
def download_voucher_bundle(
    voucher_id: str,
    user: CurrentUser,
    db: Annotated[Session, Depends(db_session)],
) -> StreamingResponse:
    voucher = get_voucher(db, voucher_id)
    if not access_voucher(user, voucher):
        raise HTTPException(404, "Voucher not found")

    attachments = []
    for attachment in voucher.attachments:
        path = (UPLOAD_ROOT / attachment.storage_key).resolve()
        if UPLOAD_ROOT not in path.parents or not path.is_file():
            raise HTTPException(
                404, f"Attached file {attachment.original_name!r} is missing"
            )
        safe_name = Path(attachment.original_name.replace("\\", "/")).name
        safe_name = "".join(
            character
            for character in safe_name
            if character.isalnum() or character in " ._-()[]"
        ).strip(" .")
        attachments.append(
            (attachment, path, safe_name or f"attachment-{attachment.id}")
        )

    archive = SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b")
    archive_root = "".join(
        character
        for character in voucher.id
        if character.isascii() and (character.isalnum() or character in "-_.")
    )
    if not archive_root:
        archive.close()
        raise HTTPException(500, "Voucher ID cannot be used for a download bundle")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        root = archive_root
        bundle.writestr(f"{root}/approval-note.html", approval_note_html(voucher))
        bundle.writestr(
            f"{root}/voucher.json",
            json.dumps(serialize(voucher), ensure_ascii=False, indent=2),
        )
        for attachment, path, safe_name in attachments:
            bundle.write(
                path,
                arcname=f"{root}/attachments/{attachment.id}-{safe_name}",
            )
    archive.seek(0)

    def stream_archive():
        try:
            while chunk := archive.read(64 * 1024):
                yield chunk
        finally:
            archive.close()

    download_filename = quote(f"{voucher.id}-complete.zip", safe="")
    return StreamingResponse(
        stream_archive(),
        media_type="application/zip",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{download_filename}"
        },
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
    if action == "reprint_note":
        if user.role not in {Role.ACCOUNTS, Role.ADMIN}:
            raise HTTPException(403, "Only Accounts or Admin can reprint an approval note")
        if v.status not in {
            Status.PRINTING,
            Status.PAYMENT_PROCESSING,
            Status.PAYMENT_RECEIVED,
            Status.CLOSED,
        }:
            raise HTTPException(409, "Approval notes can be reprinted after Accounts approval")
        require_printed_note(v)
        v.approval_note_printed_at = utc_now()
        v.events.append(
            VoucherEvent(
                actor_id=user.id,
                actor_name=user.display_name,
                actor_role=user.role,
                action=action,
                occurred_at=utc_now(),
            )
        )
        db.commit()
        return serialize(get_voucher(db, v.id))

    allowed = {
        (Status.HR_REVIEW, Role.HR, "verify"): Status.ADMIN_APPROVAL,
        (Status.ADMIN_APPROVAL, Role.ADMIN, "approve"): Status.ACCOUNTS_REVIEW,
        (Status.ACCOUNTS_REVIEW, Role.ACCOUNTS, "approve"): Status.PRINTING,
        (Status.PRINTING, Role.ACCOUNTS, "start_payment"): Status.PAYMENT_PROCESSING,
        (
            Status.PAYMENT_PROCESSING,
            Role.ACCOUNTS,
            "mark_paid",
        ): Status.PAYMENT_RECEIVED,
        (Status.PAYMENT_RECEIVED, Role.EMPLOYEE, "confirm_receipt"): Status.CLOSED,
    }
    if v.employee_id == user.id and action not in {
        "verify",
        "approve",
        "confirm_receipt",
        "print_note",
    }:
        raise HTTPException(403, "You cannot perform this action on your own voucher")
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
        if action == "print_note":
            if user.role not in {Role.ACCOUNTS, Role.ADMIN}:
                raise HTTPException(403, "Only Accounts or Admin can print an approval note")
            if v.status not in {
                Status.PRINTING,
                Status.PAYMENT_PROCESSING,
                Status.PAYMENT_RECEIVED,
                Status.CLOSED,
            }:
                raise HTTPException(409, "Approval notes can be printed after Accounts approval")
            target_status = v.status
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
        if action == "verify":
            missing_bills = [
                expense
                for expense in v.expenses
                if expense.category in {"Airfare", "Public transport"}
                and not any(
                    attachment.expense_line_id == expense.id
                    for attachment in v.attachments
                )
            ]
            if missing_bills:
                raise HTTPException(
                    422,
                    "Attach a bill to every Airfare and Public transport expense before HR can verify",
                )
        if action == "approve" and v.status == Status.ACCOUNTS_REVIEW:
            gst_expenses = [expense for expense in v.expenses if expense.is_gst]
            breakdown = data.gst_breakdown or []
            breakdown_by_id = {item.expense_id: item for item in breakdown}
            gst_expense_ids = {expense.id for expense in gst_expenses}
            if (
                len(breakdown_by_id) != len(breakdown)
                or set(breakdown_by_id) != gst_expense_ids
            ):
                raise HTTPException(
                    422,
                    "Enter gross and GST amounts for every GST-marked expense",
                )
            for expense in gst_expenses:
                amounts = breakdown_by_id[expense.id]
                if amounts.gross_amount + amounts.gst_amount != expense.amount:
                    raise HTTPException(
                        422,
                        "Gross amount plus GST amount must equal the submitted total for every GST bill",
                    )
            for expense in gst_expenses:
                amounts = breakdown_by_id[expense.id]
                expense.gross_amount = amounts.gross_amount
                expense.gst_amount = amounts.gst_amount
        if action == "mark_paid":
            if not data.payment_date:
                raise HTTPException(422, "Payment date is required")
            if v.payment_method != "cash" and not (
                data.payment_reference and data.payment_reference.strip()
            ):
                raise HTTPException(
                    422, "Payment reference is required unless payment was made in cash"
                )
            payment_reference = (
                data.payment_reference.strip() if data.payment_reference else ""
            )
            v.payment_reference = payment_reference or None
            v.payment_date = data.payment_date
        if action == "start_payment":
            if not (
                v.payment_account
                and v.payment_method
                and v.approval_recipient
                and v.approval_note_printed_at
                and (not v.project_id or approval_project_reference(v))
            ):
                raise HTTPException(
                    409, "Complete and print the approval note before payment processing"
                )
        if action == "print_note":
            if not data.approval_recipient or not data.approval_recipient.strip():
                raise HTTPException(422, "Enter who the approval note is addressed to")
            if not data.payment_account or not data.payment_account.strip():
                raise HTTPException(422, "Enter the account used to pay this voucher")
            if not data.payment_method:
                raise HTTPException(422, "Choose a payment medium")
            project_reference = (
                data.approval_project_code.strip()
                if data.approval_project_code and data.approval_project_code.strip()
                else approval_project_reference(v)
            )
            if v.project_id and not project_reference:
                raise HTTPException(
                    422, "Enter the project name or code for the approval note"
                )
            require_approval_signatures(v)
            v.approval_recipient = data.approval_recipient.strip()
            v.approval_project_code = project_reference
            v.payment_account = data.payment_account.strip()
            v.payment_method = data.payment_method
            v.approval_note_printed_at = utc_now()
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
