import os
from fastapi import FastAPI
from sqlalchemy import create_engine

engine = create_engine(os.environ["DATABASE_URL"])
app = FastAPI()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/items")
def create_item():
    return {"created": True}
