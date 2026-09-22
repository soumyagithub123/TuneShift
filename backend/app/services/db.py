import os
from datetime import datetime
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

MONGO_URI = os.getenv("MONGO_URI", "")

# Initialize MongoDB Client
client = AsyncIOMotorClient(MONGO_URI)
db = client.tuneshift
jobs_collection = db.jobs

async def create_job(job_id: str, filename: str, mode: str):
    await jobs_collection.insert_one({
        "job_id": job_id,
        "filename": filename,
        "mode": mode,
        "status": "queued",
        "message": "Job queued",
        "result_url": None,
        "created_at": datetime.utcnow().isoformat()
    })

async def update_job(job_id: str, status: str, message: str, result_url: str = None):
    update_data = {"status": status, "message": message}
    if result_url:
        update_data["result_url"] = result_url
    await jobs_collection.update_one({"job_id": job_id}, {"$set": update_data})

async def get_job(job_id: str):
    doc = await jobs_collection.find_one({"job_id": job_id})
    if doc:
        doc["_id"] = str(doc["_id"])
    return doc

async def delete_job(job_id: str):
    await jobs_collection.delete_one({"job_id": job_id})


async def rename_job(job_id: str, filename: str):
    await jobs_collection.update_one({"job_id": job_id}, {"$set": {"filename": filename}})


async def get_history():
    # Lyrics-only jobs are throw-away results, not something to list in history.
    cursor = jobs_collection.find({"mode": {"$ne": "lyrics"}}).sort("created_at", -1)
    history = []
    async for doc in cursor:
        doc["_id"] = str(doc["_id"])
        history.append(doc)
    return history
