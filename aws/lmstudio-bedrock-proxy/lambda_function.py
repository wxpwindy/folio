import json
import os
import uuid
from datetime import datetime, timezone

import boto3

bedrock = boto3.client("bedrock-runtime")


def _json(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(body),
    }


def _unauthorized() -> dict:
    return _json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})


def _check_auth(headers: dict) -> bool:
    expected = (os.environ.get("API_TOKEN") or "").strip()
    if not expected:
        return True
    auth = (headers.get("authorization") or headers.get("Authorization") or "").strip()
    return auth == f"Bearer {expected}"


def _to_bedrock_messages(openai_messages: list) -> tuple[list, list]:
    system_parts = []
    messages = []
    for item in openai_messages:
        role = item.get("role")
        content = item.get("content", "")
        if not isinstance(content, str):
            continue
        if role == "system":
            system_parts.append({"text": content})
            continue
        if role not in ("user", "assistant"):
            continue
        messages.append({"role": role, "content": [{"text": content}]})
    return messages, system_parts


def _chat_completions(payload: dict) -> dict:
    requested_model = (payload.get("model") or "").strip() or os.environ.get("MODEL_ALIAS", "google/gemma-4-e4b")
    bedrock_model_id = (os.environ.get("BEDROCK_MODEL_ID") or "google.gemma-3-4b-it").strip()
    messages, system = _to_bedrock_messages(payload.get("messages") or [])
    if not messages:
        return _json(400, {"error": {"message": "messages must include at least one user/assistant message", "type": "invalid_request_error"}})

    temperature = payload.get("temperature")
    max_tokens = payload.get("max_tokens")

    inference = {}
    if isinstance(temperature, (int, float)):
        inference["temperature"] = float(temperature)
    if isinstance(max_tokens, int) and max_tokens > 0:
        inference["maxTokens"] = int(max_tokens)

    args = {
        "modelId": bedrock_model_id,
        "messages": messages,
    }
    if system:
        args["system"] = system
    if inference:
        args["inferenceConfig"] = inference

    response = bedrock.converse(**args)
    output_parts = (((response.get("output") or {}).get("message") or {}).get("content") or [])
    text_parts = [part.get("text", "") for part in output_parts if isinstance(part, dict) and isinstance(part.get("text"), str)]
    content = "\n".join([part for part in text_parts if part])

    finish_reason = ((response.get("stopReason") or "").lower() or "stop")
    if finish_reason not in ("stop", "length", "content_filter", "tool_calls"):
        finish_reason = "stop"

    now = int(datetime.now(timezone.utc).timestamp())
    body = {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": now,
        "model": requested_model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": finish_reason,
            }
        ],
    }
    return _json(200, body)


def handler(event, _context):
    try:
        headers = event.get("headers") or {}
        if not _check_auth(headers):
            return _unauthorized()

        raw_path = (event.get("rawPath") or "/").rstrip("/")
        method = ((event.get("requestContext") or {}).get("http") or {}).get("method", "GET").upper()

        if method == "GET" and raw_path == "/v1/models":
            alias = (os.environ.get("MODEL_ALIAS") or "google/gemma-4-e4b").strip()
            bedrock_model_id = (os.environ.get("BEDROCK_MODEL_ID") or "google.gemma-3-4b-it").strip()
            return _json(200, {
                "object": "list",
                "data": [
                    {"id": alias, "object": "model", "owned_by": "aws-bedrock"},
                    {"id": bedrock_model_id, "object": "model", "owned_by": "aws-bedrock"},
                ],
            })

        if method == "POST" and raw_path == "/v1/chat/completions":
            body = event.get("body") or "{}"
            if event.get("isBase64Encoded"):
                import base64

                body = base64.b64decode(body).decode("utf-8")
            payload = json.loads(body)
            return _chat_completions(payload)

        return _json(404, {"error": {"message": "Endpoint not found", "type": "invalid_request_error"}})
    except Exception as error:
        return _json(502, {"error": {"message": f"Upstream model error: {str(error)}", "type": "server_error"}})
