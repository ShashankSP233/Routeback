"""Run the RouteBack web app and API together on localhost:3080."""
import os

import uvicorn
from dotenv import load_dotenv


if __name__ == "__main__":
    load_dotenv()
    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "3080")),
        reload=os.getenv("RELOAD", "0") == "1",
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
    )
