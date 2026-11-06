import os
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


ROUTEBACK_DB_URL = os.getenv(
    "ROUTEBACK_DB_URL",
    "postgresql+psycopg://routeback:routeback@localhost:5432/routeback",
)
engine = create_engine(ROUTEBACK_DB_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def db_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session
