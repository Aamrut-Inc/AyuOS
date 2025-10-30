from fastapi import APIRouter

from app.api.routes.v1.user import router as user_router_v1

head_router = APIRouter()

head_router.include_router(user_router_v1, prefix="/users", tags=["users"])

__all__ = ["head_router"]
