#!/usr/bin/env python
# IndexTTS2 常驻合成服务：模型只加载一次，之后每次 HTTP 请求直接合成。
#
# 启动（由 voice/say.mjs 自动拉起，也可手动）：
#   D:\index-tts2\.venv\Scripts\python.exe voice\indextts2_server.py
#
# 接口：
#   GET  /health                -> {"ok": true, "ready": bool}
#   POST /synth {"text": "...", "output": "...", "ref": "..."} -> {"ok": true, "output": "..."}
#
# 安全：空闲 IDLE_SECONDS 秒后自动退出（释放 7~10GB 内存/显存），
#       加载前检查物理内存余量，不够就拒绝，避免再把系统拖死。
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INDEX_ROOT = os.environ.get("INDEXTTS_ROOT", "")
MODEL_DIR = os.environ.get("INDEXTTS_MODEL_DIR", "")
REF_AUDIO = os.environ.get("INDEXTTS_REF", "")
PORT = int(os.environ.get("INDEXTTS_PORT", "8765"))
IDLE_SECONDS = int(os.environ.get("INDEXTTS_IDLE", "0"))
MIN_FREE_MB = int(os.environ.get("INDEXTTS_MIN_FREE_MB", "2500"))
MIN_COMMIT_MB = int(os.environ.get("INDEXTTS_MIN_COMMIT_MB", "5500"))

# 情绪预设：8 维向量，顺序 [高兴, 愤怒, 悲伤, 恐惧, 反感, 低落, 惊讶, 平静]
# 用 emo_vector 不需要加载 qwen 情感模型，还能显式控制语气强弱（emoAlpha 缩放）
EMOTION_PRESETS = {
    "开心": [0.55, 0, 0, 0, 0, 0, 0, 0.45],
    "激动": [0.50, 0, 0, 0, 0, 0, 0.20, 0.30],
    "温柔": [0.30, 0, 0, 0, 0, 0, 0, 0.70],
    "撒娇": [0.35, 0, 0, 0, 0, 0, 0, 0.65],
    "生气": [0, 0.85, 0, 0, 0, 0, 0, 0.15],
    "委屈": [0, 0, 0.25, 0, 0, 0.60, 0, 0.15],
    "难过": [0, 0, 0.70, 0, 0, 0.25, 0, 0.05],
    "惊讶": [0.15, 0, 0, 0, 0, 0, 0.60, 0.25],
    "平静": [0, 0, 0, 0, 0, 0, 0, 1.0],
}


os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
# [提速] 大 CPU 多核：让 BigVGAN（CPU 声码器）和文本处理吃满多线程
_CPU = os.cpu_count() or 8
os.environ.setdefault("OMP_NUM_THREADS", str(min(16, _CPU)))
os.environ.setdefault("MKL_NUM_THREADS", str(min(16, _CPU)))
sys.path.insert(0, INDEX_ROOT)
os.chdir(INDEX_ROOT)

TTS = None
LOCK = threading.Lock()
LAST_ACTIVE = time.time()


def log(msg):
    print(msg, flush=True)


def health_numbers():
    """返回 (可用物理内存MB, 可用提交内存MB)"""
    try:
        import ctypes
        from ctypes import wintypes

        class MS(ctypes.Structure):
            _fields_ = [
                ("dwLength", wintypes.DWORD), ("dwMemoryLoad", wintypes.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        m = MS()
        m.dwLength = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return int(m.ullAvailPhys // 2 ** 20), int(m.ullAvailPageFile // 2 ** 20)
    except Exception:
        return (99999, 99999)


def try_expand_commit(target_mb):
    """提交内存不足时，临时申请一大块提交内存逼 Windows 扩大页面文件（C 盘要有空间）。"""
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        kernel32.VirtualAlloc.restype = ctypes.c_void_p
        kernel32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong, ctypes.c_ulong]
        kernel32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong]
        MEM_COMMIT, MEM_RESERVE, MEM_RELEASE, PAGE_READWRITE = 0x1000, 0x2000, 0x8000, 0x04
        size = max(512, int(target_mb)) * 1024 * 1024
        p = kernel32.VirtualAlloc(None, ctypes.c_size_t(size), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
        log(f">> 尝试扩大页面文件：申请 {int(target_mb)}MB 提交内存 → {'成功' if p else '失败（C 盘空间不足？）'}")
        time.sleep(2)
        if p:
            kernel32.VirtualFree(ctypes.c_void_p(p), ctypes.c_size_t(0), MEM_RELEASE)
        return bool(p)
    except Exception as error:
        log(f"!! 扩大页面文件异常: {error!r}")
        return False


def load_model():
    global TTS
    phys, commit = health_numbers()
    log(f">> loading IndexTTS2 ... (free RAM {phys}MB, commit avail {commit}MB)")
    # 页面文件太小/提交内存不足时，加载到一半会 CUDA OOM 崩掉，还会留下坏上下文。
    # 这里提前拒绝并退出（下次调用重新尝试），比硬跑靠谱。
    if phys < MIN_FREE_MB or commit < MIN_COMMIT_MB:
        log(f"!! 内存不足（物理 {phys}MB / 提交 {commit}MB，阈值 {MIN_FREE_MB}/{MIN_COMMIT_MB}MB）")
        # [自愈] 提交内存不足时先尝试让 Windows 扩大页面文件（C 盘有空间才行）
        if commit < MIN_COMMIT_MB:
            try_expand_commit(max(2048, MIN_COMMIT_MB - commit + 2048))
            phys, commit = health_numbers()
            log(f">> 扩大后再检查：物理 {phys}MB / 提交 {commit}MB")
        if phys < MIN_FREE_MB or commit < MIN_COMMIT_MB:
            log("!! 仍然不足，拒绝加载并退出（下次调用重试）")
            os._exit(3)
    try:
        import torch

        # [提速/稳] CPU 声码器吃满多线程；cuDNN benchmark 让卷积选最快算法
        torch.set_num_threads(max(1, min(16, os.cpu_count() or 8)))
        if torch.cuda.is_available():
            torch.backends.cudnn.benchmark = True

        from indextts.infer_v2 import IndexTTS2
        from indextts.utils.model_download import ensure_models_available

        aux = ensure_models_available(MODEL_DIR)
        TTS = IndexTTS2(
            cfg_path=os.path.join(MODEL_DIR, "config.yaml"),
            model_dir=MODEL_DIR,
            use_fp16=True,
            device="cuda",
            use_qwen_emo=False,
            use_cuda_kernel=False,
            aux_paths=aux,
        )
        log(">> IndexTTS2 ready")
    except Exception as error:
        log("!! 模型加载失败，进程退出: " + repr(error))
        log(traceback.format_exc())
        os._exit(4)


def idle_watchdog():
    # IDLE_SECONDS <= 0 表示常驻模式：不因空闲退出，直到主程序停止（stop-stack 会杀掉本进程）
    if IDLE_SECONDS <= 0:
        log(">> 常驻模式：空闲不退出（随机器人主程序一起停止）")
        return
    while True:
        time.sleep(20)
        if TTS is None:
            continue
        idle = time.time() - LAST_ACTIVE
        if idle > IDLE_SECONDS:
            log(f">> 空闲 {int(idle)}s 超过 {IDLE_SECONDS}s，自动退出释放内存/显存")
            os._exit(0)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log("[http] " + (fmt % args))

    def _send(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "ready": TTS is not None})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/synth":
            self._send(404, {"ok": False, "error": "not found"})
            return
        global LAST_ACTIVE
        LAST_ACTIVE = time.time()
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or "{}")
        except Exception:
            self._send(400, {"ok": False, "error": "bad json"})
            return
        text = str(body.get("text") or "").strip()
        output = str(body.get("output") or "").strip()
        ref = str(body.get("ref") or REF_AUDIO)
        emotion_audio = str(body.get("emotionAudio") or "").strip()
        emotion = str(body.get("emotion") or "").strip()
        raw_vector = body.get("emoVector")
        try:
            emo_alpha = float(body.get("emoAlpha") or 0)
        except (TypeError, ValueError):
            emo_alpha = 0.0
        if not text or not output:
            self._send(400, {"ok": False, "error": "text/output required"})
            return
        if TTS is None:
            self._send(503, {"ok": False, "error": "model not ready"})
            return
        try:
            kwargs = {"spk_audio_prompt": ref, "text": text, "output_path": output, "verbose": False}
            emo_vector = None
            if isinstance(raw_vector, (list, tuple)) and len(raw_vector) == 8:
                try:
                    emo_vector = [max(0.0, float(x)) for x in raw_vector]
                except (TypeError, ValueError):
                    emo_vector = None
            elif emotion and emotion in EMOTION_PRESETS:
                emo_vector = list(EMOTION_PRESETS[emotion])
            if emo_vector is not None:
                # 用情绪向量时，emo_alpha 直接缩放情绪强度（0=平静 ~ 1=满强度）
                kwargs["emo_vector"] = emo_vector
                kwargs["emo_alpha"] = emo_alpha if emo_alpha > 0 else 0.85
                log(f">> 情绪: {emotion or 'vector'} alpha={kwargs['emo_alpha']}")
            elif emotion_audio and os.path.isfile(emotion_audio):
                # emotionAudio：语气/情绪参考（同一段参考音也能把语气带过来）
                kwargs["emo_audio_prompt"] = emotion_audio
                kwargs["emo_alpha"] = emo_alpha if emo_alpha > 0 else 0.7
            with LOCK:
                TTS.infer(**kwargs)
            ok = os.path.isfile(output) and os.path.getsize(output) > 1000
            # [稳定] 每次合成后释放显存碎片，避免长时间运行后分配失败
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            self._send(200 if ok else 500, {"ok": ok, "output": output, "bytes": os.path.getsize(output) if ok else 0})
        except Exception as error:
            log("ERROR: " + repr(error))
            log(traceback.format_exc())
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            message = str(error)
            # [稳定] CUDA 上下文出错后进程没法再用，必须退出等下次重新加载
            if "CUDA" in message or "cuda" in message:
                self._send(500, {"ok": False, "error": message + "（显存/驱动异常，服务即将重启）"})
                log("!! CUDA 错误，服务退出等待重启")
                time.sleep(0.5)
                os._exit(5)
            self._send(500, {"ok": False, "error": message})


def main():
    log(f">> IndexTTS2 server starting on 127.0.0.1:{PORT}")
    log(f">> model_dir={MODEL_DIR} ref={REF_AUDIO} idle={IDLE_SECONDS}s")
    thread = threading.Thread(target=load_model, daemon=True)
    thread.start()
    threading.Thread(target=idle_watchdog, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
