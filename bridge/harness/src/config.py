"""Configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Resolve .env relative to the harness project root (one level above src/).
HARNESS_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = HARNESS_ROOT / ".env"

@dataclass(frozen=True)
class Config:
    worker_url: str
    api_key: str
    openai_api_key: str

    r2_bucket: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_endpoint_url: str

    @classmethod
    def from_env(cls) -> Config:
        """Load config from .env file at the harness project root."""
        load_dotenv(ENV_FILE)

        def _require(name: str) -> str:
            val = os.environ.get(name, "").strip()
            if not val:
                raise RuntimeError(f"Missing required environment variable: {name}")
            return val

        account_id = _require("CLOUDFLARE_SANDBOX_R2_ACCOUNT_ID")

        return cls(
            worker_url=_require("CLOUDFLARE_SANDBOX_WORKER_URL"),
            api_key=os.environ.get("CLOUDFLARE_SANDBOX_API_KEY", "").strip(),
            openai_api_key=_require("OPENAI_API_KEY"),
            r2_bucket=_require("CLOUDFLARE_SANDBOX_R2_BUCKET"),
            r2_account_id=account_id,
            r2_access_key_id=_require("CLOUDFLARE_SANDBOX_R2_ACCESS_KEY_ID"),
            r2_secret_access_key=_require("CLOUDFLARE_SANDBOX_R2_SECRET_ACCESS_KEY"),
            r2_endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
        )

    def print_summary(self) -> None:
        print(f"  worker  = {self.worker_url}")
        print(f"  bucket  = {self.r2_bucket}")
        print(f"  r2      = {self.r2_endpoint_url}")
        print(f"  api_key = {'(set)' if self.api_key else '(not set)'}")
