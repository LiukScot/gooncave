import csv
import os

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, UploadFile
from huggingface_hub import hf_hub_download
from PIL import Image

MODEL_REPO = os.getenv("WD14_REPO", "SmilingWolf/wd-v1-4-convnextv2-tagger-v2")
MODEL_FILE = os.getenv("WD14_MODEL_FILE", "model.onnx")
TAGS_FILE = os.getenv("WD14_TAGS_FILE", "selected_tags.csv")

THRESHOLDS = {
    "general": float(os.getenv("WD14_THRESHOLD_GENERAL", "0.35")),
    "artist": float(os.getenv("WD14_THRESHOLD_ARTIST", "0.5")),
    "character": float(os.getenv("WD14_THRESHOLD_CHARACTER", "0.5")),
    "copyright": float(os.getenv("WD14_THRESHOLD_COPYRIGHT", "0.5")),
    "meta": float(os.getenv("WD14_THRESHOLD_META", "0.5")),
}

CATEGORY_MAP = {
    0: "general",
    1: "artist",
    2: "character",
    3: "copyright",
    4: "meta",
}

app = FastAPI()


def load_tags(csv_path: str):
    tags = []
    categories = []
    with open(csv_path, "r", encoding="utf-8") as handle:
        sample = handle.read(2048)
        handle.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",\t")
        except csv.Error:
            dialect = csv.excel
        reader = csv.reader(handle, dialect)
        header = next(reader, None)
        name_idx = None
        category_idx = None
        if header:
            header[0] = header[0].lstrip("\ufeff")
            lower = [col.strip().lower() for col in header]
            for key in ("name", "tag", "tag_name"):
                if key in lower:
                    name_idx = lower.index(key)
                    break
            if "category" in lower:
                category_idx = lower.index("category")
        for row in reader:
            if not row:
                continue
            idx_name = name_idx
            if idx_name is None:
                for idx, value in enumerate(row):
                    if value and not value.strip().isdigit():
                        idx_name = idx
                        break
            if idx_name is None:
                continue
            if len(row) <= idx_name:
                continue
            name = row[idx_name].strip()
            if not name:
                continue
            idx_category = category_idx
            if idx_category is None:
                for idx, value in enumerate(row):
                    if value.strip().isdigit():
                        numeric = int(value)
                        if numeric in CATEGORY_MAP:
                            idx_category = idx
                            break
            try:
                category = int(row[idx_category]) if idx_category is not None and len(row) > idx_category else 0
            except ValueError:
                category = 0
            tags.append(name)
            categories.append(CATEGORY_MAP.get(category, "general"))
    return tags, categories


def load_model():
    model_path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
    tags_path = hf_hub_download(repo_id=MODEL_REPO, filename=TAGS_FILE)
    tags, categories = load_tags(tags_path)
    sess_opts = ort.SessionOptions()
    sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_opts.intra_op_num_threads = 2
    sess_opts.inter_op_num_threads = 1
    sess_opts.enable_cpu_mem_arena = False
    sess_opts.enable_mem_pattern = False
    session = ort.InferenceSession(
        model_path, sess_options=sess_opts, providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    return session, input_name, tags, categories


SESSION, INPUT_NAME, TAGS, CATEGORIES = load_model()


def prepare_image(file_obj):
    with Image.open(file_obj) as image:
        image = image.convert("RGB")
        image = image.resize((448, 448), Image.BICUBIC)
        array = np.asarray(image, dtype=np.float32)
    array = array[:, :, ::-1]
    array = np.expand_dims(array, 0)
    return array


@app.post("/tag")
async def tag_image(file: UploadFile = File(...)):
    head = await file.read(1)
    if not head:
        return {"tags": []}
    await file.seek(0)
    input_tensor = prepare_image(file.file)
    output = SESSION.run(None, {INPUT_NAME: input_tensor})[0][0]
    results = []
    for tag, category, score in zip(TAGS, CATEGORIES, output):
        threshold = THRESHOLDS.get(category, THRESHOLDS["general"])
        if score >= threshold:
            results.append(
                {
                    "tag": tag,
                    "category": category,
                    "score": float(score),
                }
            )
    results.sort(key=lambda item: item["score"], reverse=True)
    return {"tags": results}


@app.get("/health")
async def health():
    return {"status": "ok"}
