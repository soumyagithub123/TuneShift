from pathlib import Path


async def upload_file(file_path: Path) -> str:
    """
    Currently serves files locally via the FastAPI download endpoint.
    UploadThing cloud upload can be added later with a proper file router.
    """
    # Return a sentinel that tells the route to use the local file.
    # The actual URL will be built in the download endpoint.
    return "local"
