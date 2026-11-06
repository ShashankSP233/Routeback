from datetime import date, datetime, timezone
from decimal import Decimal
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Role(StrEnum):
    EMPLOYEE = "employee"
    HR = "hr"
    ADMIN = "admin"
    ACCOUNTS = "accounts"


class Status(StrEnum):
    HR_REVIEW = "HR review"
    ADMIN_APPROVAL = "Admin approval"
    ACCOUNTS_REVIEW = "Accounts review"
    PAYMENT_PROCESSING = "Payment processing"
    PAYMENT_RECEIVED = "Payment received"
    CLOSED = "Closed"
    REJECTED = "Rejected"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid4())
    )
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(300))
    role: Mapped[str] = mapped_column(String(30), default=Role.EMPLOYEE)
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


class Voucher(Base):
    __tablename__ = "travel_vouchers"

    id: Mapped[str] = mapped_column(
        String(30), primary_key=True, default=lambda: "TV-" + uuid4().hex[:10].upper()
    )
    employee_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    project_id: Mapped[str | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    origin: Mapped[str | None] = mapped_column(String(240), nullable=True)
    destination: Mapped[str | None] = mapped_column(String(240), nullable=True)
    travel_date: Mapped[date] = mapped_column(Date)
    medium: Mapped[str] = mapped_column(String(100))
    purpose: Mapped[str] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    status: Mapped[str] = mapped_column(
        String(40), default=Status.HR_REVIEW, index=True
    )
    payment_reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    payment_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
    employee: Mapped["User"] = relationship(foreign_keys=[employee_id])
    project: Mapped["Project | None"] = relationship()
    expenses: Mapped[list["ExpenseLine"]] = relationship(
        cascade="all, delete-orphan", order_by="ExpenseLine.id"
    )
    events: Mapped[list["VoucherEvent"]] = relationship(
        cascade="all, delete-orphan", order_by="VoucherEvent.id"
    )
    attachments: Mapped[list["Attachment"]] = relationship(cascade="all, delete-orphan")


class ExpenseLine(Base):
    __tablename__ = "travel_expense_lines"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    voucher_id: Mapped[str] = mapped_column(
        ForeignKey("travel_vouchers.id", ondelete="CASCADE"), index=True
    )
    category: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    bill_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))


class VoucherEvent(Base):
    __tablename__ = "travel_voucher_events"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    voucher_id: Mapped[str] = mapped_column(
        ForeignKey("travel_vouchers.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    actor_name: Mapped[str] = mapped_column(String(200))
    actor_role: Mapped[str] = mapped_column(String(30))
    action: Mapped[str] = mapped_column(String(80))
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )


class Attachment(Base):
    __tablename__ = "travel_voucher_attachments"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    voucher_id: Mapped[str] = mapped_column(
        ForeignKey("travel_vouchers.id", ondelete="CASCADE"), index=True
    )
    original_name: Mapped[str] = mapped_column(String(255))
    storage_key: Mapped[str] = mapped_column(String(500), unique=True)
    content_type: Mapped[str] = mapped_column(String(120))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now
    )
