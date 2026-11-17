import base64
import os
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

os.environ.setdefault(
    "SESSION_SECRET", "test-session-secret-with-at-least-32-characters"
)

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.database import Base
from backend.main import (
    ActionIn,
    approval_note_html,
    approval_project_reference,
    approval_signature_event,
    get_voucher,
    list_vouchers,
    voucher_action,
)
from backend.models import (
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


class VoucherSelfApprovalTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def create_user(self, role, suffix):
        user = User(
            username=f"{role}-{suffix}",
            display_name=f"{role.title()} {suffix}",
            password_hash="test-hash",
            role=role,
        )
        self.db.add(user)
        self.db.flush()
        return user

    def create_voucher(self, role, status, suffix):
        owner = self.create_user(role, suffix)
        voucher = Voucher(
            id=f"SELF-{suffix}",
            employee_id=owner.id,
            travel_date=date(2026, 1, 1),
            travel_end_date=date(2026, 1, 1),
            medium="Taxi",
            purpose="Test self-approval",
            amount=Decimal("100.00"),
            status=status,
        )
        voucher.events.append(
            VoucherEvent(
                actor_id=owner.id,
                actor_name=owner.display_name,
                actor_role=owner.role,
                action="Submitted",
                occurred_at=utc_now(),
            )
        )
        self.db.add(voucher)
        self.db.commit()
        return owner, voucher

    def test_owner_can_take_their_role_approval_stage(self):
        cases = (
            (Role.HR, Status.HR_REVIEW, "verify", Status.ADMIN_APPROVAL),
            (Role.ADMIN, Status.ADMIN_APPROVAL, "approve", Status.ACCOUNTS_REVIEW),
            (Role.ACCOUNTS, Status.ACCOUNTS_REVIEW, "approve", Status.PRINTING),
        )
        for index, (role, status, action, next_status) in enumerate(cases):
            with self.subTest(role=role):
                owner, voucher = self.create_voucher(role, status, index)
                queue = list_vouchers(owner, self.db)["queue"]
                self.assertIn(voucher.id, [item["id"] for item in queue])

                result = voucher_action(
                    voucher.id, ActionIn(action=action), owner, self.db
                )
                self.assertEqual(result["status"], next_status)
                self.assertEqual(result["events"][-1]["action"], action)

    def test_owner_cannot_approve_before_their_stage_or_process_own_payment(self):
        admin, voucher = self.create_voucher(
            Role.ADMIN, Status.ADMIN_APPROVAL, "reject"
        )
        with self.assertRaises(HTTPException) as error:
            voucher_action(voucher.id, ActionIn(action="reject"), admin, self.db)
        self.assertEqual(error.exception.status_code, 403)

        admin, voucher = self.create_voucher(
            Role.ADMIN, Status.HR_REVIEW, "wrong-stage"
        )
        with self.assertRaises(HTTPException) as error:
            voucher_action(voucher.id, ActionIn(action="approve"), admin, self.db)
        self.assertEqual(error.exception.status_code, 409)

        accounts, payment_voucher = self.create_voucher(
            Role.ACCOUNTS, Status.PAYMENT_PROCESSING, "payment"
        )
        with self.assertRaises(HTTPException) as error:
            voucher_action(
                payment_voucher.id,
                ActionIn(action="mark_paid", payment_date=date(2026, 1, 2)),
                accounts,
                self.db,
            )
        self.assertEqual(error.exception.status_code, 403)

    def test_admin_submission_is_omitted_from_employee_fields_and_signatures(self):
        admin, voucher = self.create_voucher(
            Role.ADMIN, Status.CLOSED, "signature"
        )
        project = Project(name="Assam")
        self.db.add(project)
        self.db.flush()
        voucher.project = project
        voucher.origin = "Guwahati"
        hr = self.create_user(Role.HR, "signature")
        accounts = self.create_user(Role.ACCOUNTS, "signature")
        voucher.events.extend(
            [
                VoucherEvent(
                    actor_id=hr.id,
                    actor_name=hr.display_name,
                    actor_role=Role.HR,
                    action="verify",
                    occurred_at=utc_now(),
                ),
                VoucherEvent(
                    actor_id=admin.id,
                    actor_name=admin.display_name,
                    actor_role=Role.ADMIN,
                    action="approve",
                    occurred_at=utc_now(),
                ),
                VoucherEvent(
                    actor_id=accounts.id,
                    actor_name=accounts.display_name,
                    actor_role=Role.ACCOUNTS,
                    action="approve",
                    occurred_at=utc_now(),
                ),
            ]
        )
        self.db.commit()

        result = voucher_action(
            voucher.id,
            ActionIn(
                action="print_note",
                approval_recipient="Finance",
                payment_account="Main account",
                payment_method="cash",
            ),
            admin,
            self.db,
        )
        self.assertEqual(result["approval_project_code"], "Assam")

        loaded = get_voucher(self.db, voucher.id)
        submission = approval_signature_event(loaded, Role.EMPLOYEE, "Submitted")
        self.assertIsNone(submission)
        note_html = approval_note_html(loaded)
        self.assertNotIn("DRAFT —", note_html)
        self.assertNotIn("<td>From</td>", note_html)
        self.assertNotIn("Payment To:", note_html)
        self.assertNotIn("<small>Employee", note_html)
        self.assertIn("<h2 class=\"section-title\">Project-wise Fund Requirement</h2>", note_html)
        self.assertIn("<strong>Assam</strong>", note_html)
        self.assertIn("<table class=\"fund-total\">", note_html)
        self.assertIn("<div class=\"purpose\">", note_html)
        self.assertIn("<div class=\"digital-signatures\">", note_html)
        self.assertIn("<div class=\"physical-signatures\">", note_html)
        self.assertIn("Admin Approver", note_html)
        self.assertIn('<span class="company-name">DHARTI</span>', note_html)
        encoded_logo = base64.b64encode(
            (Path(__file__).resolve().parents[1] / "logo.png").read_bytes()
        ).decode("ascii")
        self.assertIn(f"data:image/png;base64,{encoded_logo}", note_html)

    def test_approval_note_lists_bills_without_embedding_their_files(self):
        admin, voucher = self.create_voucher(
            Role.ADMIN, Status.CLOSED, "bill-annexures"
        )
        expense = ExpenseLine(
            voucher_id=voucher.id,
            category="Taxi",
            description="Airport transfer",
            bill_number="T-42",
            amount=Decimal("100.00"),
        )
        self.db.add(expense)
        self.db.flush()
        voucher.attachments.extend(
            [
                Attachment(
                    original_name="taxi receipt.png",
                    storage_key=f"{voucher.id}/image.png",
                    content_type="image/png",
                    expense_line=expense,
                ),
                Attachment(
                    original_name="hotel receipt.pdf",
                    storage_key=f"{voucher.id}/receipt.pdf",
                    content_type="application/pdf",
                    expense_line=expense,
                ),
            ]
        )
        self.db.commit()

        note_html = approval_note_html(get_voucher(self.db, voucher.id))
        self.assertIn("taxi receipt.png", note_html)
        self.assertIn("hotel receipt.pdf", note_html)
        self.assertNotIn("ATTACHED BILL", note_html)
        self.assertNotIn('class="bill-image"', note_html)
        self.assertNotIn('class="bill-pdf"', note_html)

    def test_start_location_is_the_project_reference_when_no_project_exists(self):
        admin, voucher = self.create_voucher(
            Role.ADMIN, Status.CLOSED, "location-reference"
        )
        voucher.origin = "Dibrugarh"
        self.db.commit()

        self.assertEqual(
            approval_project_reference(get_voucher(self.db, voucher.id)),
            "Dibrugarh",
        )
        self.assertIn(
            "<strong>Dibrugarh</strong>",
            approval_note_html(get_voucher(self.db, voucher.id)),
        )


if __name__ == "__main__":
    unittest.main()
