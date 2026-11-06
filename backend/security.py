import hashlib
import hmac
import secrets


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024
    )
    return f"scrypt${salt.hex()}${derived.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt_hex, expected = stored.split("$", 2)
        if algorithm != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=bytes.fromhex(salt_hex),
            n=2**15,
            r=8,
            p=1,
            maxmem=64 * 1024 * 1024,
        )
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False
