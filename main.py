#!/usr/bin/env python3
"""
serv-UI - Web-based Server Management Interface
A lightweight alternative to Webmin, designed to work with Tailscale serve.
"""

import asyncio
import fcntl
import glob
import json
import logging
import os
import pty
import pwd
import re
import select
import shlex
import signal
import ssl
import struct
import subprocess
import sys
import termios
import tempfile
import threading
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

IS_ROOT = os.getuid() == 0

app = FastAPI(title="serv-UI", version="2.2.1")


@app.middleware("http")
async def no_cache_html(request: Request, call_next):
    """Prevent browsers from serving cached HTML (which pins stale app.js)."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# Static files and templates
BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _sudo(cmd: str) -> str:
    """Prefix command with sudo when not running as root."""
    if IS_ROOT:
        return cmd
    return f"sudo {cmd}"


async def _get_json(req: Request) -> dict:
    """Parse JSON body, returning 400 instead of 500 on malformed input."""
    try:
        data = await req.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="JSON body must be an object")
    return data


@app.get("/api/selfex/status")
async def selfex_status():
    """Check if selfEx is installed and return its URL."""
    # NOTE: a bare /opt/selfex directory is NOT sufficient evidence
    # (an empty leftover dir would cause a false positive and open a dead URL).
    # Require the systemd unit or the real server files installed by install-selfex1.sh.
    svc_enabled = await run_cmd("systemctl is-enabled selfex 2>/dev/null", timeout=5)
    svc_active = await run_cmd("systemctl is-active selfex 2>/dev/null", timeout=5)
    svc_file = await run_cmd("test -f /etc/systemd/system/selfex.service", timeout=5)
    server_js = await run_cmd("test -f /opt/selfex/server/server.js", timeout=5)
    installed = any(
        r["returncode"] == 0
        for r in (svc_enabled, svc_active, svc_file, server_js)
    )
    active = svc_active["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3362/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "active": active, "url": url}


# --- Helper: run shell command ---
async def run_cmd(cmd: str, timeout: int = 30, extra_env: dict | None = None) -> dict:
    """Run a shell command and return stdout, stderr, returncode."""
    try:
        env = os.environ.copy()
        env["DEBIAN_FRONTEND"] = "noninteractive"
        if extra_env:
            env.update(extra_env)

        proc = await asyncio.create_subprocess_shell(
            cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return {
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "returncode": proc.returncode,
        }
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return {"stdout": "", "stderr": "Command timed out", "returncode": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "returncode": -1}


def get_primary_user() -> tuple[str, str, str]:
    """
    Find the primary human user on the system, their home directory and login shell.
    Returns (username, home_dir, shell).
    """
    # 1. Try UID 1000 (standard primary user on Debian/Ubuntu)
    try:
        pw = pwd.getpwuid(1000)
        if pw and pw.pw_name != "nobody" and pw.pw_shell not in ("/bin/false", "/usr/sbin/nologin"):
            return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"
    except KeyError:
        pass

    # 2. Search for any UID >= 1000 user in /home
    for pw in pwd.getpwall():
        if 1000 <= pw.pw_uid < 65534 and pw.pw_name != "servui":
            if pw.pw_shell not in ("/bin/false", "/usr/sbin/nologin", "/bin/sync") and pw.pw_dir.startswith("/home/"):
                return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"

    # 3. Fallback to process owner
    try:
        pw = pwd.getpwuid(os.getuid())
        return pw.pw_name, pw.pw_dir, pw.pw_shell or "/bin/bash"
    except Exception:
        return "root", "/root", "/bin/bash"



def get_cpu_temperature() -> float | None:
    """Get current CPU temperature in Celsius across different hardware platforms."""
    try:
        temp_data = psutil.sensors_temperatures()
        if temp_data:
            priority_keys = ["coretemp", "cpu_thermal", "k10temp", "zenpower", "soc_thermal", "cpu-thermal"]
            for key in priority_keys:
                if key in temp_data and temp_data[key]:
                    entries = temp_data[key]
                    for entry in entries:
                        if entry.label in ("Package id 0", "Tctl", "Tdie", "CPU", "SoC"):
                            return round(entry.current, 1)
                    return round(entries[0].current, 1)

            for name, entries in temp_data.items():
                if ("cpu" in name.lower() or "core" in name.lower() or "temp" in name.lower()) and entries:
                    return round(entries[0].current, 1)

            for name, entries in temp_data.items():
                if entries:
                    return round(entries[0].current, 1)
    except Exception:
        pass

    try:
        thermal_dir = Path("/sys/class/thermal")
        if thermal_dir.exists():
            for p in thermal_dir.glob("thermal_zone*"):
                type_file = p / "type"
                temp_file = p / "temp"
                if temp_file.exists():
                    ztype = type_file.read_text().strip().lower() if type_file.exists() else ""
                    if "cpu" in ztype or "x86_pkg_temp" in ztype or "pkg" in ztype:
                        val = float(temp_file.read_text().strip()) / 1000.0
                        return round(val, 1)

            tz0 = thermal_dir / "thermal_zone0" / "temp"
            if tz0.exists():
                return round(float(tz0.read_text().strip()) / 1000.0, 1)
    except Exception:
        pass

    return None


# ============================================================
# 1. Dashboard - System Information
# ============================================================
@app.get("/api/system/info")
async def system_info():
    """Get comprehensive system information."""
    cpu_percent = psutil.cpu_percent(interval=1)
    cpu_freq = psutil.cpu_freq()
    cpu_count = psutil.cpu_count()
    load_avg = os.getloadavg()
    cpu_temp = get_cpu_temperature()

    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")

    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime = datetime.now() - boot_time

    # Network I/O
    net = psutil.net_io_counters()

    # Temperature (if available)
    temps = {}
    try:
        temp_data = psutil.sensors_temperatures()
        if temp_data:
            for name, entries in temp_data.items():
                if entries:
                    temps[name] = entries[0].current
    except (AttributeError, Exception):
        pass

    # Get hostname
    hostname_result = await run_cmd("hostname")
    hostname = hostname_result["stdout"].strip()

    # Get OS info
    os_info = await run_cmd("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'\"' -f2")
    os_name = os_info["stdout"].strip() or "Unknown"

    # Get kernel
    kernel_result = await run_cmd("uname -r")
    kernel = kernel_result["stdout"].strip()

    return {
        "hostname": hostname,
        "os": os_name,
        "kernel": kernel,
        "uptime_seconds": int(uptime.total_seconds()),
        "boot_time": boot_time.isoformat(),
        "cpu": {
            "percent": cpu_percent,
            "count_physical": cpu_count,
            "freq_current": round(cpu_freq.current, 0) if cpu_freq else None,
            "temp": cpu_temp,
            "load_avg": {
                "1min": round(load_avg[0], 2),
                "5min": round(load_avg[1], 2),
                "15min": round(load_avg[2], 2),
            },
        },
        "memory": {
            "total": mem.total,
            "available": mem.available,
            "used": mem.used,
            "percent": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_percent": swap.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "network": {
            "bytes_sent": net.bytes_sent,
            "bytes_recv": net.bytes_recv,
            "packets_sent": net.packets_sent,
            "packets_recv": net.packets_recv,
        },
        "temperatures": temps,
    }


@app.get("/api/system/processes")
async def system_processes():
    """Get top processes by CPU usage."""
    procs = []
    for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "username"]):
        try:
            info = proc.info
            procs.append({
                "pid": info["pid"],
                "name": info["name"],
                "cpu": info["cpu_percent"] or 0,
                "memory": round(info["memory_percent"] or 0, 1),
                "user": info["username"] or "-",
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    # Sort by CPU desc
    procs.sort(key=lambda x: x["cpu"], reverse=True)
    return procs[:30]


@app.get("/api/ports/listen")
async def ports_listen():
    """List listening services (ss -tulnp) and their LAN accessibility."""
    try:
        return await _collect_listening_ports()
    except Exception as e:
        logging.getLogger("uvicorn.error").exception("ports_listen failed")
        return {"ips": [], "ports": [], "error": str(e)}


async def _collect_listening_ports() -> dict:
    # -H (no header) is not supported by older iproute2; parsing skips headers anyway
    result = await run_cmd("ss -tulnp 2>/dev/null", timeout=15)
    error = None
    local_idx = 4
    using_netstat = False
    if result["returncode"] != 0 or not result["stdout"].strip():
        alt = await run_cmd("netstat -tulnp 2>/dev/null", timeout=15)
        if alt["returncode"] == 0 and alt["stdout"].strip():
            result = alt
            local_idx = 3
            using_netstat = True
        else:
            error = f"ss rc={result['returncode']}: {result['stderr'].strip()[:200]}"

    def classify(host: str) -> str:
        if host in ("0.0.0.0", "::", "*", ""):
            return "all"
        ip = host.strip("[]")
        if ip == "::1" or ip.startswith("127."):
            return "local"
        return "limited"

    rows = {}
    for line in result["stdout"].splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        proto = parts[0]
        addr_field = parts[local_idx]
        if addr_field.startswith("["):
            try:
                close = addr_field.index("]")
                host = addr_field[1:close]
                port = addr_field[close + 1:].rpartition(":")[2]
            except ValueError:
                continue
        else:
            host, _, port = addr_field.rpartition(":")
        host = host.split("%")[0]
        if not port.isdigit():
            continue

        # NOTE: ss pads lines with trailing spaces, so searching only the
        # last whitespace-separated token (line.rsplit(" ", 1)[-1]) yields ""
        # and drops every process. Always search the whole line.
        proc_names = []
        pids = []
        if using_netstat:
            # netstat -tulnp format: "... LISTEN 1234/sshd" ("-" when unknown)
            m = re.search(r"\s(\d+)/([^\s]+)\s*$", line.rstrip())
            if m:
                pid, name = m.group(1), m.group(2).split(":")[0]
                if name not in ("-", ""):
                    proc_names.append(name)
                    pids.append(pid)
        else:
            procs = re.findall(r'\(\("([^"]+)",pid=(\d+)', line)
            for name, pid in procs:
                if name not in proc_names:
                    proc_names.append(name)
                if pid not in pids:
                    pids.append(pid)

        key = (proto, host, port)
        if key in rows:
            for name in proc_names:
                if name not in rows[key]["processes"]:
                    rows[key]["processes"].append(name)
            for pid in pids:
                if pid not in rows[key]["pids"]:
                    rows[key]["pids"].append(pid)
        else:
            rows[key] = {
                "proto": "tcp" if proto.startswith("tcp") else "udp",
                "address": host,
                "port": int(port),
                "processes": proc_names,
                "pids": pids,
                "access": classify(host),
            }

    # Fallback/supplement via psutil: ss/netstat may hide processes
    # (non-root, truncated output, permission errors). Fill rows that
    # still have no process info from kernel socket table.
    try:
        need_fill = any(not r["processes"] for r in rows.values())
    except Exception:
        need_fill = False
    if need_fill:
        try:
            import socket as _socket

            _pid_name_cache: dict[int, str] = {}

            def _proc_name(pid) -> str:
                try:
                    pid_int = int(pid)
                except (TypeError, ValueError):
                    return ""
                if pid_int in _pid_name_cache:
                    return _pid_name_cache[pid_int]
                try:
                    name = psutil.Process(pid_int).name() or ""
                except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                    name = ""
                except Exception:
                    name = ""
                _pid_name_cache[pid_int] = name
                return name

            # (proto, port) -> {"names": [...], "pids": [...]}
            listen_map: dict[tuple[str, int], dict] = {}
            try:
                conns = psutil.net_connections(kind="inet")
            except Exception:
                conns = []
            for c in conns:
                try:
                    if c.type == _socket.SOCK_DGRAM:
                        cproto = "udp"
                    elif c.type == _socket.SOCK_STREAM:
                        # TCP: only listening sockets are relevant
                        if c.status != "LISTEN":
                            continue
                        cproto = "tcp"
                    else:
                        continue
                    if not c.laddr:
                        continue
                    cport = int(c.laddr.port)
                    if not c.pid:
                        continue
                    key2 = (cproto, cport)
                    entry = listen_map.setdefault(key2, {"names": [], "pids": []})
                    pid_s = str(c.pid)
                    if pid_s not in entry["pids"]:
                        entry["pids"].append(pid_s)
                    nm = _proc_name(c.pid)
                    if nm and nm not in entry["names"]:
                        entry["names"].append(nm)
                except Exception:
                    continue
            for r in rows.values():
                if r["processes"]:
                    continue
                hit = listen_map.get((r["proto"], r["port"]))
                if hit:
                    r["processes"] = hit["names"]
                    r["pids"] = hit["pids"]
        except Exception:
            pass

    # Host IP addresses per interface (loopback excluded)
    ips = []
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            if iface == "lo":
                continue
            for a in addrs:
                fam = getattr(a.family, "value", a.family)
                if fam in (2, 10) and not str(a.address).startswith("fe80"):
                    addr = str(a.address).split("%")[0]
                    entry = {"iface": iface, "address": addr}
                    if entry not in ips:
                        ips.append(entry)
    except Exception:
        pass

    return {"ips": ips, "ports": sorted(rows.values(), key=lambda r: r["port"]), "error": error}


# ============================================================
# 2. Service Management
# ============================================================
@app.get("/api/services")
async def list_services():
    """List installed services with their status."""
    result = await run_cmd(
        "systemctl list-units --type=service --all --no-pager --plain --no-legend "
        "| awk '{print $1, $3, $4}'",
        timeout=15,
    )
    services = []
    for line in result["stdout"].strip().split("\n"):
        parts = line.split()
        if len(parts) >= 2:
            name = parts[0]
            active = parts[1] if len(parts) > 1 else "unknown"
            sub = parts[2] if len(parts) > 2 else "-"
            services.append({"name": name, "active": active, "sub": sub})
    return services


@app.get("/api/services/{service_name}/status")
async def service_status(service_name: str):
    """Get detailed status of a specific service."""
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(f"systemctl is-active {service_name}")
    is_active = result["stdout"].strip()
    result2 = await run_cmd(f"systemctl status {service_name}")
    return {
        "name": service_name,
        "is_active": is_active,
        "status_output": result2["stdout"],
    }


@app.post("/api/services/{service_name}/start")
async def service_start(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl start {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/stop")
async def service_stop(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl stop {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/restart")
async def service_restart(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl restart {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/enable")
async def service_enable(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl enable {service_name}"))
    return {"success": result["returncode"] == 0, **result}


@app.post("/api/services/{service_name}/disable")
async def service_disable(service_name: str):
    if not all(c.isalnum() or c in "-_." for c in service_name):
        raise HTTPException(status_code=400, detail="Invalid service name")
    result = await run_cmd(_sudo(f"systemctl disable {service_name}"))
    return {"success": result["returncode"] == 0, **result}


# ============================================================
# 3. Package Management
# ============================================================
@app.get("/api/packages/updates")
async def check_updates():
    """Check for available package updates."""
    # Update package lists
    await run_cmd(_sudo("apt-get update -qq"), timeout=60)
    result = await run_cmd("apt list --upgradable 2>/dev/null | tail -n +2")
    packages = []
    for line in result["stdout"].strip().split("\n"):
        line = line.strip()
        if line and "/" in line:
            name = line.split("/")[0]
            packages.append({"name": name, "info": line})
    return {"packages": packages, "count": len(packages)}


@app.post("/api/packages/upgrade")
async def upgrade_packages():
    """Upgrade all packages safely with dependency auto-repair."""
    # Step 1: Repair unconfigured packages
    r_dpkg = await run_cmd(_sudo("dpkg --configure -a"), timeout=120)
    # Step 2: Auto-fix broken dependencies
    r_fix = await run_cmd(
        _sudo("apt-get --fix-broken install -y "
        "-o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold'"),
        timeout=180,
    )
    # Step 3: Upgrade packages
    result = await run_cmd(
        _sudo("apt-get upgrade -y "
        "-o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold'"),
        timeout=600,
    )
    
    combined_stdout = f"{r_dpkg['stdout']}\n{r_fix['stdout']}\n{result['stdout']}".strip()
    errors = result["stderr"].strip()
    if r_fix["returncode"] != 0 and r_fix["stderr"].strip():
        errors = f"{r_fix['stderr'].strip()}\n{errors}".strip()
    if r_dpkg["returncode"] != 0 and r_dpkg["stderr"].strip():
        errors = f"{r_dpkg['stderr'].strip()}\n{errors}".strip()

    return {
        "success": result["returncode"] == 0,
        "output": combined_stdout,
        "errors": errors,
    }


@app.post("/api/packages/upgrade/{package_name}")
async def upgrade_single_package(package_name: str):
    """Upgrade a single package."""
    if not all(c.isalnum() or c in "-_." for c in package_name):
        raise HTTPException(status_code=400, detail="Invalid package name")
    # Repair dpkg and dependencies first
    await run_cmd(_sudo("dpkg --configure -a"), timeout=60)
    await run_cmd(
        _sudo("apt-get --fix-broken install -y "
        "-o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold'"),
        timeout=120,
    )
    result = await run_cmd(
        _sudo(f"apt-get install --only-upgrade -y {package_name} "
        "-o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold'"),
        timeout=300,
    )
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }


@app.post("/api/packages/fix")
async def fix_packages():
    """Repair broken packages and unmet dependencies."""
    r1 = await run_cmd(_sudo("dpkg --configure -a"), timeout=120)
    r2 = await run_cmd(
        _sudo("apt-get --fix-broken install -y "
        "-o Dpkg::Options::='--force-confdef' "
        "-o Dpkg::Options::='--force-confold'"),
        timeout=300,
    )
    success = (r2["returncode"] == 0) and (r1["returncode"] == 0)
    return {
        "success": success,
        "output": (r1["stdout"] + "\n" + r2["stdout"]).strip(),
        "errors": (r1["stderr"] + "\n" + r2["stderr"]).strip(),
    }


@app.post("/api/packages/force-upgrade")
async def force_upgrade_packages():
    """Force-upgrade all packages including phased updates."""
    result = await run_cmd(
        _sudo("apt -o APT::Get::Always-Include-Phased-Updates=true upgrade -y"),
        timeout=600,
    )
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }


@app.post("/api/packages/autoremove")
async def autoremove_packages():
    """Remove packages that are no longer needed."""
    result = await run_cmd(_sudo("apt autoremove -y"), timeout=300)
    return {
        "success": result["returncode"] == 0,
        "output": result["stdout"],
        "errors": result["stderr"],
    }



# ============================================================
# 4. Web Terminal (WebSocket + PTY)
# ============================================================
def _get_user_uid(username: str) -> int:
    """Get UID for a username from /etc/passwd."""
    try:
        pw = pwd.getpwnam(username)
        return pw.pw_uid
    except KeyError:
        return 1000


def _build_term_env(target_user: str, target_home: str, target_shell: str) -> dict:
    """Build environment for terminal process, including keyring/D-Bus vars like selfcode."""
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["SHELL"] = target_shell
    env["USER"] = target_user
    env["LOGNAME"] = target_user
    env["HOME"] = target_home
    env["COLUMNS"] = "120"
    env["LINES"] = "30"

    # Add keyring / D-Bus environment (same as selfcode)
    uid = _get_user_uid(target_user)
    run_user_dir = f"/run/user/{uid}"
    if os.path.isdir(run_user_dir):
        env["XDG_RUNTIME_DIR"] = run_user_dir
        bus_path = os.path.join(run_user_dir, "bus")
        if os.path.exists(bus_path):
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus_path}"
        keyring_dir = os.path.join(run_user_dir, "keyring")
        if os.path.isdir(keyring_dir):
            env["GNOME_KEYRING_CONTROL"] = keyring_dir

    # Add ~/.local/bin to PATH (for CLI tools like agy)
    local_bin = os.path.join(target_home, ".local", "bin")
    if os.path.isdir(local_bin):
        env["PATH"] = f"{local_bin}:{env.get('PATH', '/usr/local/bin:/usr/bin:/bin')}"

    return env


def _sanitize_cwd(cwd: str) -> str:
    """Validate a client-supplied terminal working directory (returns '' when invalid)."""
    cwd = (cwd or "").strip()
    if not cwd or not cwd.startswith("/"):
        return ""
    if ".." in cwd.split("/") or any(ch in cwd for ch in ("\n", "\r", "\x00")):
        return ""
    if not os.path.isdir(cwd):
        return ""
    return cwd


@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket, cwd: str = ""):
    """WebSocket-based terminal using PTY for clean terminal emulation.
    Uses setpriv when running as root (like selfcode), falls back to sudo+su.
    Optional `cwd` query param starts the shell in that directory."""
    await websocket.accept()

    target_user, target_home, target_shell = get_primary_user()
    is_root = os.getuid() == 0
    cur_user_name = pwd.getpwuid(os.getuid()).pw_name
    env = _build_term_env(target_user, target_home, target_shell)
    start_dir = _sanitize_cwd(cwd)

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process: stdin, stdout, and stderr are automatically connected to slave PTY
        try:
            cur_uid = os.getuid()
            cur_user = pwd.getpwuid(cur_uid).pw_name if pwd.getpwuid(cur_uid) else ""

            cd_prefix = f"cd {shlex.quote(start_dir)} && " if start_dir else ""
            inner_cmd = f"{cd_prefix}exec {target_shell} -l"

            if cur_uid == 0 and cur_user != target_user:
                # Running as root: use setpriv for clean user switch (like selfcode)
                # setpriv replaces the process image directly, so job control works correctly
                if start_dir:
                    child_argv = [
                        "/usr/bin/setpriv",
                        f"--reuid={target_user}",
                        f"--regid={target_user}",
                        "--init-groups",
                        "--",
                        "/bin/bash",
                        "-c",
                        inner_cmd,
                    ]
                else:
                    child_argv = [
                        "/usr/bin/setpriv",
                        f"--reuid={target_user}",
                        f"--regid={target_user}",
                        "--init-groups",
                        "--",
                        target_shell,
                        "-l",
                    ]
                os.execvpe("/usr/bin/setpriv", child_argv, env)
            elif cur_user != target_user:
                # Non-root: switch via sudo + su (su is allowed in sudoers)
                if start_dir:
                    child_argv = ["/usr/bin/sudo", "/usr/bin/su", "-", target_user, "-c", inner_cmd]
                else:
                    child_argv = ["/usr/bin/sudo", "/usr/bin/su", "-", target_user]
                os.execvpe("/usr/bin/sudo", child_argv, env)
            else:
                # Already target_user: cd to home directory and launch login shell
                try:
                    os.chdir(start_dir or target_home)
                except Exception:
                    pass
                os.execvpe(target_shell, [target_shell, "-l"], env)
        except Exception:
            try:
                os.chdir(start_dir or target_home)
            except Exception:
                pass
            os.execlp(target_shell, target_shell, "-l")
        sys.exit(1)


    # Parent process
    try:
        winsize = struct.pack("HHHH", 30, 120, 0, 0)
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

    loop = asyncio.get_running_loop()

    async def pty_to_ws():
        try:
            while True:
                data = await loop.run_in_executor(None, os.read, master_fd, 4096)
                if not data:
                    break
                await websocket.send_text(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    async def ws_to_pty():
        try:
            while True:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                    msg_type = data.get("type")
                    if msg_type == "input":
                        inp_data = data.get("data", "")
                        os.write(master_fd, inp_data.encode("utf-8"))
                    elif msg_type == "resize":
                        cols = int(data.get("cols", 120))
                        rows = int(data.get("rows", 30))
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                except (json.JSONDecodeError, OSError):
                    pass
        except (WebSocketDisconnect, Exception):
            pass

    task_pty = asyncio.create_task(pty_to_ws())
    task_ws = asyncio.create_task(ws_to_pty())

    done, pending = await asyncio.wait(
        [task_pty, task_ws],
        return_when=asyncio.FIRST_COMPLETED,
    )

    for task in pending:
        task.cancel()

    try:
        os.close(master_fd)
    except OSError:
        pass

    try:
        os.kill(pid, signal.SIGHUP)
        await asyncio.sleep(0.05)
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass

    try:
        os.waitpid(pid, os.WNOHANG)
    except (OSError, ChildProcessError):
        pass


# ============================================================
# 5. Wi-Fi Management
# ============================================================
def parse_nmcli_wifi_list(output: str):
    """Parse nmcli terse output for Wi-Fi networks."""
    results = []
    for line in output.strip().split("\n"):
        if not line.strip():
            continue
        parts = re.split(r"(?<!\\):", line)
        parts = [p.replace(r"\:", ":").replace(r"\\", "\\") for p in parts]
        if len(parts) >= 6:
            in_use = parts[0].strip() == "*"
            ssid = parts[1].strip()
            bssid = parts[2].strip()
            signal_str = parts[3].strip()
            signal_val = int(signal_str) if signal_str.isdigit() else 0
            bars = parts[4].strip()
            security = parts[5].strip()
            chan = parts[6].strip() if len(parts) > 6 else ""
            freq = parts[7].strip() if len(parts) > 7 else ""

            if not ssid and not bssid:
                continue

            results.append({
                "in_use": in_use,
                "ssid": ssid or "(非公開ネットワーク)",
                "bssid": bssid,
                "signal": signal_val,
                "bars": bars,
                "security": security or "Open",
                "chan": chan,
                "freq": freq,
            })

    results.sort(key=lambda x: (not x["in_use"], -x["signal"]))
    return results


@app.get("/api/wifi/status")
async def wifi_status():
    """Get Wi-Fi status and current connection info."""
    which_nmcli = await run_cmd("which nmcli")
    nmcli_available = which_nmcli["returncode"] == 0

    if nmcli_available:
        radio = await run_cmd("nmcli radio wifi")
        wifi_enabled = radio["stdout"].strip().lower() == "enabled"

        dev_res = await run_cmd("nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device")
        wifi_devices = []
        active_conn = None

        for line in dev_res["stdout"].strip().split("\n"):
            if not line.strip():
                continue
            parts = line.split(":")
            if len(parts) >= 3 and parts[1].strip() == "wifi":
                dev_name = parts[0].strip()
                dev_state = parts[2].strip()
                conn_name = parts[3].strip() if len(parts) > 3 else ""
                is_connected = dev_state in ("connected", "接続済み")
                wifi_devices.append({
                    "device": dev_name,
                    "state": dev_state,
                    "connection": conn_name,
                    "connected": is_connected,
                })
                if is_connected and conn_name:
                    active_conn = {
                        "ssid": conn_name,
                        "device": dev_name,
                        "state": dev_state,
                    }

        if active_conn:
            ip_res = await run_cmd(f"ip -4 addr show {active_conn['device']} 2>/dev/null | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){{3}}' || true")
            active_conn["ip"] = ip_res["stdout"].strip()

            wifi_info = await run_cmd("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY device wifi list 2>/dev/null")
            parsed = parse_nmcli_wifi_list(wifi_info["stdout"])
            for net in parsed:
                if net["in_use"] or net["ssid"] == active_conn["ssid"]:
                    active_conn["signal"] = net["signal"]
                    active_conn["security"] = net["security"]
                    active_conn["bssid"] = net["bssid"]
                    break

        return {
            "available": len(wifi_devices) > 0,
            "nmcli": True,
            "enabled": wifi_enabled,
            "connected": active_conn is not None,
            "current": active_conn,
            "devices": wifi_devices,
        }

    # Fallback when nmcli is not present
    wlan_ifaces = []
    try:
        for p in Path("/sys/class/net").iterdir():
            if (p / "wireless").exists() or (p / "phy80211").exists() or p.name.startswith("wl"):
                wlan_ifaces.append(p.name)
    except Exception:
        pass

    return {
        "available": len(wlan_ifaces) > 0,
        "nmcli": False,
        "enabled": len(wlan_ifaces) > 0,
        "connected": False,
        "current": None,
        "devices": [{"device": iface, "state": "unknown", "connected": False} for iface in wlan_ifaces],
        "message": "NetworkManager (nmcli) がインストールされていません。" if not nmcli_available else "",
    }


@app.get("/api/wifi/scan")
async def wifi_scan():
    """Scan for available Wi-Fi networks."""
    which_nmcli = await run_cmd("which nmcli")
    if which_nmcli["returncode"] != 0:
        return {
            "success": False,
            "networks": [],
            "error": "nmcli (NetworkManager) が必要です。sudo apt install network-manager を実行してください。",
        }

    scan_res = await run_cmd(_sudo("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY,CHAN,FREQ device wifi list --rescan yes"), timeout=25)
    if scan_res["returncode"] != 0:
        scan_res = await run_cmd("nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,BARS,SECURITY,CHAN,FREQ device wifi list", timeout=15)

    networks = parse_nmcli_wifi_list(scan_res["stdout"])
    return {
        "success": True,
        "networks": networks,
        "count": len(networks),
    }


@app.post("/api/wifi/connect")
async def wifi_connect(req: Request):
    """Connect to a Wi-Fi network."""
    data = await _get_json(req)
    ssid = data.get("ssid", "").strip()
    password = data.get("password", "").strip()
    bssid = data.get("bssid", "").strip()

    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    if password:
        if bssid:
            cmd = _sudo(f'nmcli device wifi connect {shlex.quote(ssid)} password {shlex.quote(password)} bssid {shlex.quote(bssid)}')
        else:
            cmd = _sudo(f'nmcli device wifi connect {shlex.quote(ssid)} password {shlex.quote(password)}')
    else:
        if bssid:
            cmd = _sudo(f'nmcli device wifi connect {shlex.quote(ssid)} bssid {shlex.quote(bssid)}')
        else:
            cmd = _sudo(f'nmcli device wifi connect {shlex.quote(ssid)}')

    res = await run_cmd(cmd, timeout=45)
    success = res["returncode"] == 0
    return {
        "success": success,
        "message": res["stdout"].strip() if success else (res["stderr"].strip() or res["stdout"].strip() or "接続に失敗しました"),
    }


@app.post("/api/wifi/disconnect")
async def wifi_disconnect(req: Request):
    """Disconnect currently connected Wi-Fi."""
    data = await _get_json(req)
    ssid = data.get("ssid", "").strip()
    device = data.get("device", "").strip()

    if ssid:
        res = await run_cmd(_sudo(f'nmcli connection down id {shlex.quote(ssid)}'), timeout=15)
        if res["returncode"] == 0:
            return {"success": True, "message": f"{ssid} から切断しました"}

    if device:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", device):
            raise HTTPException(status_code=400, detail="invalid device")
        res = await run_cmd(_sudo(f'nmcli device disconnect {shlex.quote(device)}'), timeout=15)
        return {
            "success": res["returncode"] == 0,
            "message": res["stdout"].strip() or res["stderr"].strip(),
        }

    wifi_disconnect_cmd = (
        "nmcli -t -f DEVICE,TYPE device | grep ':wifi' | cut -d: -f1 | xargs -r -I{} nmcli device disconnect {}"
        if IS_ROOT
        else "sudo nmcli -t -f DEVICE,TYPE device | grep ':wifi' | cut -d: -f1 | xargs -r -I{} sudo nmcli device disconnect {}"
    )
    res = await run_cmd(wifi_disconnect_cmd, timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": "Wi-Fiを切断しました",
    }


@app.post("/api/wifi/forget")
async def wifi_forget(req: Request):
    """Forget / delete a saved Wi-Fi connection profile."""
    data = await _get_json(req)
    ssid = data.get("ssid", "").strip()
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    res = await run_cmd(_sudo(f'nmcli connection delete id {shlex.quote(ssid)}'), timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


@app.post("/api/wifi/toggle")
async def wifi_toggle(req: Request):
    """Turn Wi-Fi radio on/off."""
    data = await _get_json(req)
    enable = data.get("enable", True)
    cmd = _sudo("nmcli radio wifi on") if enable else _sudo("nmcli radio wifi off")
    res = await run_cmd(cmd, timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


# ============================================================
# 6. Disk Management (表示専用: パーティション操作は Disk Manager で行う)
# 表示内容は Disk Manager の「パーティション操作」と同じ構成。
# ============================================================
_DISK_WIPE_PATH_RE = re.compile(r"^/dev/(sd[a-z]+|hd[a-z]+|vd[a-z]+|nvme\d+n\d+|mmcblk\d+)$")
_DISK_PART_DEV_RE = re.compile(r"^/dev/(sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|nvme\d+n\d+p?\d*|mmcblk\d+p?\d*)$")
_DISK_MIB = 1024 * 1024


def _disk_fmt_bytes(n):
    try:
        n = int(n)
    except Exception:
        return "-"
    if n >= 1024**3:
        return f"{n / (1024**3):.2f} GB"
    if n >= 1024**2:
        return f"{n / (1024**2):.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def _disk_is_system_mountpoint(mp: str) -> bool:
    if not mp or mp.startswith("["):
        return False
    mp = os.path.normpath(mp.strip())
    if mp == "/" or mp == "/boot" or mp == "/boot/efi" or mp.startswith("/boot/"):
        return True
    for deny in ("/boot", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
                 "/proc", "/sys", "/dev", "/run", "/var", "/home", "/root",
                 "/opt", "/srv", "/tmp"):
        if mp == deny or mp.startswith(deny + "/"):
            return True
    return False


async def _disk_findmnt_source(mountpoint: str) -> str:
    r = await run_cmd(f"findmnt -n -o SOURCE {shlex.quote(mountpoint)} 2>/dev/null", timeout=5)
    if r["returncode"] != 0:
        return ""
    src = (r["stdout"] or "").strip().split("\n")[0].strip()
    if "[" in src:
        src = src.split("[")[0]
    return src if src.startswith("/dev/") else ""


async def _disk_system_disk() -> str:
    src = await _disk_findmnt_source("/")
    if not src.startswith("/dev/"):
        return ""
    r = await run_cmd(f"lsblk -n -o PKNAME {shlex.quote(src)} 2>/dev/null", timeout=5)
    parent = (r["stdout"] or "").strip().split("\n")[0].strip()
    if parent:
        return f"/dev/{parent}"
    return src


async def _disk_system_partitions() -> set:
    crit = set()
    for mp in ("/", "/boot", "/boot/efi"):
        src = await _disk_findmnt_source(mp)
        if src:
            crit.add(src)
    return crit


async def _disk_parted_parse_free(disk: str):
    table = ""
    bounds: dict[int, tuple[int, int]] = {}
    frees: list[dict] = []
    r = await run_cmd(f"parted -s {shlex.quote(disk)} unit B print free 2>/dev/null", timeout=30)
    out = (r["stdout"] or "") + (r["stderr"] or "")
    if r["returncode"] != 0:
        low = out.lower()
        if ("unknown" in low or "認識できません" in out
                or "unrecognised" in low or "unrecognized" in low):
            return "unknown", bounds, frees
        return table, bounds, frees
    for line in out.split("\n"):
        s = line.strip()
        low = s.lower()
        if "パーティションテーブル" in s or "partition table" in low:
            if "gpt" in low:
                table = "gpt"
            elif "msdos" in low or "mbr" in low:
                table = "msdos"
            else:
                table = s.split(":")[-1].strip()
            continue
        m_free = re.match(r"^(\d+)B\s+(\d+)B\s+(\d+)B\s+.*(?:空き|free)", s, re.I)
        if m_free and not re.match(r"^\d+\s", s):
            try:
                frees.append({"start_bytes": int(m_free.group(1)),
                              "end_bytes": int(m_free.group(2)),
                              "size_bytes": int(m_free.group(3))})
            except Exception:
                pass
            continue
        m_part = re.match(r"^(\d+)\s+(\d+)B\s+(\d+)B\s+(\d+)B", s)
        if m_part:
            try:
                bounds[int(m_part.group(1))] = (int(m_part.group(2)), int(m_part.group(3)))
            except Exception:
                pass
    return table, bounds, frees


async def _disk_part_number(disk: str, part: str):
    disk_base = os.path.basename(disk)
    part_base = os.path.basename(part)
    try:
        with open(f"/sys/block/{disk_base}/{part_base}/partition", "r") as f:
            return int(f.read().strip())
    except Exception:
        pass
    try:
        suffix = part_base[len(disk_base):] if part_base.startswith(disk_base) else part_base
        suffix = suffix.lstrip("p")
        if suffix.isdigit():
            return int(suffix)
    except Exception:
        pass
    return None


@app.get("/api/disks/info")
async def disks_info():
    """ディスク＋パーティション＋空き領域の一覧 (Disk Manager のパーティション操作と同構成・表示専用)。"""
    lsblk_res = await run_cmd(
        "lsblk -J -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,LABEL,UUID,PARTLABEL,PARTTYPE,PARTUUID,"
        "FSUSED,FSAVAIL,FSUSE%,MODEL,SERIAL,TRAN,PARTTYPE 2>/dev/null",
        timeout=10,
    )
    try:
        blk_data = json.loads(lsblk_res["stdout"] or "{}")
    except (json.JSONDecodeError, KeyError):
        return {"devices": []}

    sys_disk = await _disk_system_disk()
    sys_parts = await _disk_system_partitions()

    devices = []
    for dev in blk_data.get("blockdevices", []) or []:
        if dev.get("type") != "disk":
            continue
        name = dev.get("name", "")
        disk = f"/dev/{name}"
        if not _DISK_WIPE_PATH_RE.match(disk):
            continue
        try:
            size_bytes = int(dev.get("size", 0) or 0)
        except Exception:
            size_bytes = 0
        model = (dev.get("model") or "").strip()
        serial = (dev.get("serial") or "").strip()
        tran = (dev.get("tran") or "").strip()
        table, bounds, frees = await _disk_parted_parse_free(disk)
        partitions = []
        has_mount = bool(dev.get("mountpoint"))
        for child in dev.get("children") or []:
            if (child.get("type") or "") not in ("part", "raid", "lvm"):
                continue
            cname = child.get("name", "")
            cpath = f"/dev/{cname}"
            if not _DISK_PART_DEV_RE.match(cpath):
                continue
            try:
                csize = int(child.get("size", 0) or 0)
            except Exception:
                csize = 0
            cmount = child.get("mountpoint") or ""
            if cmount:
                has_mount = True
            try:
                used = int(child.get("fsused", 0) or 0)
            except Exception:
                used = 0
            try:
                avail = int(child.get("fsavail", 0) or 0)
            except Exception:
                avail = 0
            use_pct = (child.get("fsuse%") or "").strip()
            num = await _disk_part_number(disk, cpath)
            start_b, end_b = bounds.get(num, (0, 0)) if num else (0, 0)
            partitions.append({
                "name": cname, "path": cpath, "number": num,
                "start_bytes": start_b, "end_bytes": end_b,
                "size_bytes": csize, "size": _disk_fmt_bytes(csize),
                "fstype": (child.get("fstype") or "").strip(),
                "label": (child.get("label") or "").strip(),
                "uuid": (child.get("uuid") or "").strip(),
                "partlabel": (child.get("partlabel") or "").strip(),
                "parttype": (child.get("parttype") or "").strip(),
                "mountpoint": cmount,
                "system_part": (cpath in sys_parts) or _disk_is_system_mountpoint(cmount),
                "used_bytes": used, "used": _disk_fmt_bytes(used) if used else "",
                "avail_bytes": avail, "avail": _disk_fmt_bytes(avail) if avail else "",
                "use_percent": use_pct,
            })
        free_list = []
        for f in frees:
            try:
                fsize = int(f.get("size_bytes", 0) or 0)
            except Exception:
                continue
            if fsize < _DISK_MIB:
                continue
            free_list.append({**f, "size": _disk_fmt_bytes(fsize)})
        needs_init = (table in ("", "unknown")) and not partitions and not free_list
        label = f"/dev/{name} - {_disk_fmt_bytes(size_bytes)}"
        if model:
            label += f" ({model})"
        if serial:
            label += f" [{serial}]"
        if tran:
            label += f" ({tran})"
        devices.append({"path": disk, "name": name,
                        "size": _disk_fmt_bytes(size_bytes), "size_bytes": size_bytes,
                        "model": model, "serial": serial, "tran": tran, "label": label,
                        "table": table or "不明",
                        "needs_init": needs_init,
                        "partitions": partitions, "free_spaces": free_list,
                        "has_mount": has_mount, "is_system": (disk == sys_disk)})
    return {"devices": devices}


# ============================================================
# 7. serv-UI Management & System Control
# ============================================================
@app.get("/api/selfcode/status")
async def selfcode_status():
    """Check if selfcode is installed and return its URL."""
    # Check if systemd service exists or directory exists
    svc = await run_cmd("systemctl is-enabled selfcode 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/lxd-data/selfcode", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        # Get Tailscale hostname
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3339/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}



@app.get("/api/easylxd/status")

async def easylxd_status():
    """Check if Easy LXD is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled easy-lxd 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/easy-lxd", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3329/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


@app.get("/api/vmmanager/status")
async def vmmanager_status():
    """Check if VM Manager is installed and return its URL."""
    svc = await run_cmd("systemctl is-enabled vm-manage 2>/dev/null", timeout=5)
    dir_check = await run_cmd("test -d /opt/vm-manage", timeout=5)
    installed = svc["returncode"] == 0 or dir_check["returncode"] == 0

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:8090/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


@app.get("/api/diskmanager/status")
async def diskmanager_status():
    """Check if Disk Manager is installed and return its URL."""
    svc_enabled = await run_cmd("systemctl is-enabled diskmanager 2>/dev/null", timeout=5)
    svc_active = await run_cmd("systemctl is-active diskmanager 2>/dev/null", timeout=5)
    svc_file = await run_cmd("test -f /etc/systemd/system/diskmanager.service", timeout=5)
    dir_check = await run_cmd("test -d /opt/diskmanager", timeout=5)
    server_check = await run_cmd("test -f /opt/diskmanager/server.py", timeout=5)
    installed = any(
        r["returncode"] == 0
        for r in (svc_enabled, svc_active, svc_file, dir_check, server_check)
    )

    url = None
    if installed:
        ts = await run_cmd("tailscale status --json 2>/dev/null", timeout=5)
        try:
            data = json.loads(ts["stdout"])
            dns = data.get("Self", {}).get("DNSName", "")
            if dns:
                hostname = dns.rstrip(".")
                url = f"https://{hostname}:3361/"
        except (json.JSONDecodeError, KeyError):
            pass

    return {"installed": installed, "url": url}


# ============================================================
# 7.5 Backup / Restore (Clonezilla Live ISO loopback boot)
# ============================================================
CLONE_ISO_DIR = "/iso"
CLONE_ISO_GLOB = "clonezilla-live-*.iso"
GRUB_DEFAULT_FILE = "/etc/default/grub"
BACKUP_ENTRY_BEGIN = "# BEGIN servui-backup-auto"
BACKUP_ENTRY_END = "# END servui-backup-auto"
BACKUP_LABEL = "Clonezilla Auto Backup (servui)"
RESTORE_LABEL = "Clonezilla Auto Restore (servui)"
IMAGE_PREFIX_FALLBACK = "ubuntu"
# Legacy cloneauto helper (only read for IMAGE_PREFIX compatibility)
LEGACY_RESTORE_CMD = "/usr/local/sbin/clonezilla-restore"


def _validate_block_device(device: str) -> str:
    """Validate a device path like /dev/sda1. Returns the path or raises."""
    if not re.fullmatch(r"/dev/[A-Za-z0-9._-]+", device or ""):
        raise HTTPException(status_code=400, detail="invalid device")
    return device


def _parse_lsblk_partitions(stdout: str) -> list[dict]:
    """Parse `lsblk -P` output into partition dicts.

    Applies the same filter as the clonezilla helpers (TYPE="part",
    excluding swap) so that menu indexes match between serv-UI and
    clonezilla-backup / clonezilla-restore.
    """
    parts = []
    for line in stdout.splitlines():
        if 'TYPE="part"' not in line or 'FSTYPE="swap"' in line:
            continue
        fields = dict(re.findall(r'([A-Z]+)="((?:[^"\\]|\\.)*)"', line))
        parts.append({
            "device": f"/dev/{fields.get('NAME', '')}",
            "size": fields.get("SIZE", ""),
            "fstype": fields.get("FSTYPE") or None,
            "mountpoint": fields.get("MOUNTPOINT") or None,
        })
    return parts


async def _list_clonezilla_partitions() -> list[dict]:
    r = await run_cmd("lsblk -P -o NAME,SIZE,FSTYPE,MOUNTPOINT,TYPE", timeout=15)
    if r["returncode"] != 0:
        raise HTTPException(status_code=500, detail=r["stderr"] or "lsblk failed")
    return _parse_lsblk_partitions(r["stdout"])


def _clonezilla_image_prefix() -> str:
    """Read IMAGE_PREFIX from a legacy cloneauto helper if present (default: ubuntu)."""
    try:
        with open(LEGACY_RESTORE_CMD, encoding="utf-8", errors="replace") as f:
            txt = f.read()
        m = re.search(r'^for d in "\\?\$SRC_MNT"/([A-Za-z0-9._-]+)-\*; do', txt, re.M)
        if m:
            return m.group(1)
    except OSError:
        pass
    return IMAGE_PREFIX_FALLBACK


async def _find_clonezilla_iso() -> str | None:
    """Return the newest clonezilla-live-*.iso under /iso, or None."""
    matches = sorted(Path(CLONE_ISO_DIR).glob(CLONE_ISO_GLOB))
    return str(matches[-1]) if matches else None


async def _system_target_parts() -> list[str]:
    """Partitions to save/restore: EFI, /boot (if separate), root — in that order.

    Mirrors the TARGET_PARTS list of the legacy cloneauto install script.
    """
    parts: list[str] = []
    r = await run_cmd("findmnt -n -o SOURCE,FSTYPE /boot/efi", timeout=5)
    if r["returncode"] == 0:
        fields = r["stdout"].split()
        if len(fields) == 2 and fields[1] == "vfat":
            parts.append(fields[0])
    b = await run_cmd("findmnt -n -o SOURCE /boot", timeout=5)
    if b["returncode"] == 0 and b["stdout"].strip():
        boot = b["stdout"].strip()
        r = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
        if boot != r["stdout"].strip():
            parts.append(boot)
    r = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
    if r["returncode"] == 0 and r["stdout"].strip():
        parts.append(r["stdout"].strip())
    return parts


def _build_auto_entry(label: str, iso_path: str, part_uuid: str,
                      prerun_dev: str, ocs_run: str) -> str:
    """Generate an unattended Clonezilla ISO-loopback menuentry block.

    ocs_prerun mounts the image repository partition at /home/partimag and
    ocs_live_run runs ocs-sr in batch mode with all arguments fixed, so no
    interactive prompt appears. ocs_final_action=reboot (-p reboot) returns
    the machine to the normal boot entry after processing.

    toram is REQUIRED when the ISO lives on the image repository partition:
    live-boot keeps that partition mounted read-only at /run/live/findiso,
    so a plain `mount <dev> /home/partimag` would share the read-only
    superblock and every ocs-sr write fails (the run then stops at the
    "Cloning finished. You can now choose to:" menu with no image created).
    toram copies the live system into RAM and unmounts /run/live/findiso,
    freeing the partition for a normal read-write mount.
    """
    params = (
        "boot=live union=overlay username=user config components quiet noswap noeject "
        "nofastboot ip=frommedia locales=en_US.UTF-8 keyboard-layouts=NONE toram "
        'ocs_lang=en_US.UTF-8 ocs_live_batch="yes" ocs_final_action=reboot '
        f'ocs_prerun="mount {prerun_dev} /home/partimag" '
        f'ocs_live_run="{ocs_run}"'
    )
    return (
        f'\nmenuentry "{label}" {{\n'
        "    insmod part_gpt\n"
        "    insmod lvm\n"
        "    insmod ext2\n"
        "    insmod loopback\n"
        "    insmod iso9660\n"
        f"    search --no-floppy --fs-uuid --set=isodev {part_uuid}\n"
        f'    set isofile="{iso_path}"\n'
        "    loopback loop ($isodev)$isofile\n"
        f"    linux  (loop)/live/vmlinuz {params} findiso=$isofile\n"
        "    initrd (loop)/live/initrd.img\n"
        "}\n"
    )


async def _write_auto_entry_block(block: str) -> tuple[bool, str]:
    """Replace the servui-backup-auto block in 40_custom with `block` (backup first)."""
    bak = await _backup_grub_custom()
    if not bak:
        return False, "バックアップの作成に失敗しました"

    content = await _read_text(GRUB_CUSTOM_FILE)
    if content is None:
        return False, f"{GRUB_CUSTOM_FILE} を読み取れませんでした"

    pattern = re.compile(
        re.escape(BACKUP_ENTRY_BEGIN) + r".*?" + re.escape(BACKUP_ENTRY_END) + r"\n?",
        re.S,
    )
    if pattern.search(content):
        content = pattern.sub("", content)
    content = (
        content.rstrip("\n")
        + f"\n\n{BACKUP_ENTRY_BEGIN}\n"
        + block.strip("\n")
        + f"\n{BACKUP_ENTRY_END}\n"
    )

    ok, err = await _write_root_file(GRUB_CUSTOM_FILE, content)
    if not ok:
        return False, f"{GRUB_CUSTOM_FILE}への書き込みに失敗しました: {err}"
    return True, ""


async def _ensure_grub_saved() -> str:
    """Ensure GRUB_DEFAULT=saved so grub-reboot works. Returns a note or ''."""
    g = await _read_text(GRUB_DEFAULT_FILE)
    if g is None:
        raise HTTPException(status_code=500, detail="/etc/default/grub を読み取れませんでした")
    m = re.search(r"^GRUB_DEFAULT=(.*)$", g, re.M)
    if m and m.group(1).strip().strip("\"'") == "saved":
        return ""
    if m:
        cmd = _sudo(f"sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=saved/' {GRUB_DEFAULT_FILE}")
    else:
        cmd = _sudo(f"sh -c 'echo GRUB_DEFAULT=saved >> {shlex.quote(GRUB_DEFAULT_FILE)}'")
    res = await run_cmd(cmd, timeout=15)
    if res["returncode"] != 0:
        raise HTTPException(
            status_code=500,
            detail=f"GRUB_DEFAULT=saved への変更に失敗しました: {res['stderr'].strip()}",
        )
    return ("注: GRUB_DEFAULT=saved に変更しました（次回起動から1回限りのブート選択が有効になります）")


async def _list_clonezilla_images(device: str) -> list[str]:
    """List Clonezilla image directories on the given partition.

    Mirrors the image listing of clonezilla-restore (glob `<prefix>-*`,
    directories only) so indexes match.
    Temporarily mounts the partition read-only when it is not mounted.
    """
    check = await run_cmd(f"test -b {device}", timeout=5)
    if check["returncode"] != 0:
        raise HTTPException(status_code=400, detail=f"{device} is not a block device")

    prefix = _clonezilla_image_prefix()

    mnt_r = await run_cmd(f"findmnt -n -o TARGET --source {device} | head -1", timeout=5)
    src_mnt = mnt_r["stdout"].strip()
    tmp_dir = None
    if not src_mnt:
        mk = await run_cmd("mktemp -d", timeout=5)
        tmp_dir = mk["stdout"].strip()
        m = await run_cmd(f"{_sudo('mount')} -o ro {device} {tmp_dir}", timeout=30)
        if m["returncode"] != 0:
            await run_cmd(f"rmdir {tmp_dir}", timeout=5)
            raise HTTPException(
                status_code=500,
                detail=f"{device} をマウントできませんでした: {m['stderr'].strip()}",
            )
        src_mnt = tmp_dir
    try:
        ls = await run_cmd(
            f"find {src_mnt} -maxdepth 1 -type d -name '{prefix}-*' -printf '%f\\n' | LC_ALL=C sort",
            timeout=15,
        )
        return [line.strip() for line in ls["stdout"].splitlines() if line.strip()]
    finally:
        if tmp_dir:
            await run_cmd(f"{_sudo('umount')} {tmp_dir}; rmdir {tmp_dir}", timeout=15)


_SF_CLONEZILLA_BASE = "https://sourceforge.net/projects/clonezilla/files/clonezilla_live_stable"


async def _fetch_sf_listing(url: str) -> dict:
    """Fetch a SourceForge file listing page and extract the embedded net.sf.files JSON."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "servui"})
        resp = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req, timeout=15, context=_SSL_UNVERIFIED)
        )
        html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SourceForgeへの接続に失敗しました: {e}")
    m = re.search(r"net\.sf\.files\s*=\s*(\{.*?\});", html, re.S)
    if not m:
        raise HTTPException(status_code=502, detail="SourceForgeのページ解析に失敗しました")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="SourceForgeのデータ解析に失敗しました")


@app.get("/api/backup/clonezilla-versions")
async def clonezilla_versions():
    """List available Clonezilla stable versions from SourceForge."""
    data = await _fetch_sf_listing(_SF_CLONEZILLA_BASE)
    versions = []
    for name, info in data.items():
        if info.get("type") == "d" and re.match(r"^\d+\.\d+", name):
            versions.append({"name": name})
    def _ver_key(v):
        parts = re.split(r"[.\-]", v["name"])
        return [int(p) for p in parts if p.isdigit()]
    versions.sort(key=_ver_key, reverse=True)
    return {"versions": versions}


@app.get("/api/backup/clonezilla-files")
async def clonezilla_files(version: str):
    """List ISO files for a given Clonezilla version."""
    if not re.match(r"^[\d.]+-\d+$", version):
        raise HTTPException(status_code=400, detail="不正なバージョン指定です")
    url = f"{_SF_CLONEZILLA_BASE}/{version}/"
    data = await _fetch_sf_listing(url)
    files = []
    for name, info in data.items():
        if info.get("type") == "f" and name.lower().endswith(".iso"):
            dl_url = f"{_SF_CLONEZILLA_BASE}/{version}/{name}/download"
            files.append({"name": name, "download_url": dl_url})
    files.sort(key=lambda f: f["name"])
    return {"files": files}


@app.post("/api/backup/clonezilla-download")
async def clonezilla_download(req: Request):
    """Start downloading a Clonezilla ISO from SourceForge into /iso."""
    global _iso_dl_proc
    data = await _get_json(req)
    url = (data.get("url") or "").strip()
    filename = (data.get("filename") or "").strip()
    if not url or not filename:
        return {"success": False, "message": "URLとファイル名を指定してください"}
    if not re.match(r"^https?://sourceforge\.net/", url):
        return {"success": False, "message": "SourceForgeのURLを指定してください"}
    if not filename.lower().endswith(".iso"):
        return {"success": False, "message": "ISOファイルを指定してください"}
    if any(ch in filename for ch in ('"', "'", "`", "\\", "$", ";", "&", "|", "<", ">")):
        return {"success": False, "message": "ファイル名に使用できない文字が含まれています"}

    w = await run_cmd("which wget")
    if w["returncode"] != 0:
        return {"success": False, "message": "wget が見つかりません"}

    mnt = await run_cmd("findmnt -n --target /iso", timeout=5)
    if mnt["returncode"] != 0:
        return {"success": False, "message": "/iso に保存用パーティションがマウントされていません"}

    dest = f"/iso/{filename}"
    if os.path.exists(dest):
        return {"success": False, "message": f"同名のファイルが既に存在します: {filename}"}

    total = await asyncio.to_thread(_probe_content_length, url)

    async with _iso_dl_lock:
        if _iso_dl_state["running"]:
            return {"success": False, "message": "ダウンロードが既に実行中です"}
        proc = await asyncio.create_subprocess_shell(
            _sudo(f"wget -q --tries=3 --timeout=60 -O {shlex.quote(dest)} {shlex.quote(url)}"),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _iso_dl_proc = proc
        _reset_iso_dl_state(running=True, filename=filename, path=dest, total=total)
        asyncio.create_task(_iso_download_worker(proc, dest))
    return {"success": True, "filename": filename}


@app.get("/api/backup/status")
async def backup_status():
    """Check Clonezilla ISO presence, /iso mount status and GRUB one-shot boot readiness."""
    iso_path = await _find_clonezilla_iso()

    mnt = await run_cmd("findmnt -n -o SOURCE,FSTYPE,SIZE --target /iso", timeout=5)
    fields = mnt["stdout"].split()

    g = await _read_text(GRUB_DEFAULT_FILE) or ""
    gm = re.search(r"^GRUB_DEFAULT=(.*)$", g, re.M)
    grub_saved = bool(gm) and gm.group(1).strip().strip("\"'") == "saved"

    sb = await run_cmd("mokutil --sb-state 2>/dev/null", timeout=5)
    secure_boot = "secureboot enabled" in sb["stdout"].strip().lower()

    return {
        "iso_found": bool(iso_path),
        "iso_path": iso_path,
        "iso_mounted": mnt["returncode"] == 0,
        "iso_source": fields[0] if len(fields) > 0 else None,
        "iso_fstype": fields[1] if len(fields) > 1 else None,
        "iso_size": fields[2] if len(fields) > 2 else None,
        "grub_saved": grub_saved,
        "secure_boot": secure_boot,
    }


@app.get("/api/backup/partitions")
async def backup_partitions():
    """List partitions selectable as backup destination / restore source."""
    partitions = await _list_clonezilla_partitions()
    return {"partitions": partitions}


@app.post("/api/backup/images")
async def backup_images(req: Request):
    """List Clonezilla backup images stored on the given partition."""
    data = await _get_json(req)
    device = _validate_block_device(data.get("device", "").strip())
    images = await _list_clonezilla_images(device)
    return {"images": images, "prefix": _clonezilla_image_prefix()}


@app.post("/api/backup/run")
async def backup_run(req: Request):
    """Prepare a one-shot unattended Clonezilla run via ISO loopback boot.

    Writes an auto entry into 40_custom (loopback-booting the Clonezilla Live
    ISO with fixed ocs-sr arguments), ensures GRUB_DEFAULT=saved, runs
    update-grub and arms grub-reboot so the next boot performs the backup or
    restore automatically. The caller reboots afterwards.
    """
    data = await _get_json(req)
    mode = data.get("mode", "").strip()
    device = _validate_block_device(data.get("device", "").strip())
    image = (data.get("image") or "").strip()

    iso_path = await _find_clonezilla_iso()
    if not iso_path:
        raise HTTPException(
            status_code=400,
            detail=f"{CLONE_ISO_DIR} に {CLONE_ISO_GLOB} が見つかりません",
        )

    mnt = await run_cmd("findmnt -n -o SOURCE --target /iso", timeout=5)
    iso_src = mnt["stdout"].strip()
    if not iso_src:
        raise HTTPException(status_code=500, detail="/iso がマウントされていません")
    u = await run_cmd(f"blkid -s UUID -o value {shlex.quote(iso_src)}", timeout=10)
    part_uuid = u["stdout"].strip()
    if not part_uuid:
        raise HTTPException(
            status_code=500,
            detail=f"/iso パーティション ({iso_src}) のUUIDを取得できませんでした",
        )

    prefix = _clonezilla_image_prefix()
    targets = await _system_target_parts()
    if not targets:
        raise HTTPException(
            status_code=500, detail="バックアップ対象パーティション (/ 等) を検出できませんでした"
        )
    target_str = " ".join(targets)

    if mode == "backup":
        label = BACKUP_LABEL
        images = await _list_clonezilla_images(device)
        img_name = f"{prefix}-{datetime.now().strftime('%Y-%m-%d')}"
        if img_name in images:
            img_name = f"{prefix}-{datetime.now().strftime('%Y-%m-%d-%H%M%S')}"
        ocs_run = (
            f"ocs-sr -q2 -j2 -z1p -sc -p reboot -batch saveparts {img_name} {target_str}"
        )
        summary = f"保存先: {device} / イメージ: {img_name}"
    elif mode == "restore":
        label = RESTORE_LABEL
        if not image:
            raise HTTPException(status_code=400, detail="image is required")
        if not re.fullmatch(rf"{re.escape(prefix)}-[A-Za-z0-9._-]+", image):
            raise HTTPException(status_code=400, detail="invalid image name")
        images = await _list_clonezilla_images(device)
        if image not in images:
            raise HTTPException(
                status_code=404,
                detail=f"イメージ {image} が {device} 上に見つかりません",
            )
        ocs_run = (
            f"ocs-sr -g auto -k -scr -p reboot -batch restoreparts {image} {target_str}"
        )
        summary = f"復元元: {device} / イメージ: {image}"
    else:
        raise HTTPException(status_code=400, detail="mode must be 'backup' or 'restore'")

    # GRUB sees the ISO relative to the filesystem found by `search --fs-uuid`,
    # so the mount-point prefix (/iso) must be stripped, e.g. "/foo.iso" not
    # "/iso/foo.iso".
    mnt_t = await run_cmd(
        f"findmnt -n -o TARGET --source {shlex.quote(iso_src)}", timeout=5
    )
    iso_mnt = mnt_t["stdout"].strip() or "/"
    try:
        grub_iso = "/" + str(Path(iso_path).resolve().relative_to(Path(iso_mnt).resolve()))
    except ValueError:
        raise HTTPException(
            status_code=500,
            detail=f"{iso_path} はマウントポイント {iso_mnt} 配下にありません",
        )

    block = _build_auto_entry(label, grub_iso, part_uuid, device, ocs_run)

    ok, err = await _write_auto_entry_block(block)
    if not ok:
        raise HTTPException(status_code=500, detail=err)

    saved_note = await _ensure_grub_saved()

    upd = await run_cmd(_sudo("update-grub"), timeout=180)
    if upd["returncode"] != 0:
        raise HTTPException(
            status_code=500,
            detail=f"update-grub に失敗しました: {upd['stderr'].strip()[:300]}",
        )

    gr = await run_cmd(_sudo(f"grub-reboot {shlex.quote(label)}"), timeout=15)
    if gr["returncode"] != 0:
        raise HTTPException(
            status_code=500,
            detail=f"grub-reboot に失敗しました: {gr['stderr'].strip()}",
        )

    message = (
        f"{summary}\n"
        f"準備完了。再起動すると「{label}」で起動し、Clonezilla Live が自動処理します\n"
        f"対象: {target_str}"
    )
    if saved_note:
        message += f"\n{saved_note}"
    return {"success": True, "message": message, "label": label}


# ---------------------------------------------------------------------------
# Timeshift
# ---------------------------------------------------------------------------

@app.get("/api/timeshift/status")
async def timeshift_status():
    """Check whether Timeshift is installed and detect its mode (rsync/btrfs)."""
    r = await run_cmd("which timeshift 2>/dev/null", timeout=5)
    installed = r["returncode"] == 0

    mode = None
    if installed:
        mr = await run_cmd("timeshift --list 2>&1 | head -20", timeout=15)
        txt = mr["stdout"].lower()
        if "btrfs" in txt:
            mode = "btrfs"
        elif "rsync" in txt:
            mode = "rsync"

    return {"installed": installed, "mode": mode}


@app.post("/api/timeshift/install")
async def timeshift_install():
    """Install Timeshift via apt."""
    r = await run_cmd(_sudo("apt install -y timeshift"), timeout=120)
    return {
        "success": r["returncode"] == 0,
        "stdout": r["stdout"],
        "stderr": r["stderr"],
    }


def _get_timeshift_snapshot_size(name: str) -> str:
    """Return formatted size string for a Timeshift snapshot."""
    paths = [
        f"/timeshift/snapshots/{name}/rsync-log",
        f"/timeshift/snapshots-ondemand/{name}/rsync-log",
        f"/timeshift/snapshots-boot/{name}/rsync-log",
        f"/timeshift/snapshots-daily/{name}/rsync-log",
        f"/timeshift/snapshots-hourly/{name}/rsync-log",
        f"/timeshift/snapshots-weekly/{name}/rsync-log",
        f"/timeshift/snapshots-monthly/{name}/rsync-log",
    ]
    paths.extend(glob.glob(f"/run/timeshift/*/backup/timeshift/snapshots/{name}/rsync-log"))
    for p in paths:
        if os.path.isfile(p):
            try:
                with open(p, "rb") as f:
                    f.seek(max(0, f.seek(0, 2) - 4096))
                    content = f.read().decode("utf-8", errors="replace")
                m = re.search(r"Total file size:\s*([\d,]+)\s*bytes", content)
                if not m:
                    m = re.search(r"total size is\s*([\d,]+)", content)
                if m:
                    b = float(int(m.group(1).replace(",", "")))
                    for unit in ["B", "KB", "MB", "GB", "TB"]:
                        if b < 1024:
                            return f"{b:.1f} {unit}" if unit != "B" else f"{int(b)} B"
                        b /= 1024
                    return f"{b:.1f} PB"
            except Exception:
                pass
    return "-"


def _write_file_root_safe(path: str, payload: str, mkdir_dir: str | None = None) -> bool:
    """Write a file as the current user, falling back to sudo via a temp copy."""
    try:
        if mkdir_dir:
            os.makedirs(mkdir_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(payload)
        return True
    except OSError:
        pass
    try:
        fd, tmp = tempfile.mkstemp(prefix="servui_", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        cmd = f"cp '{tmp}' '{path}'"
        if mkdir_dir:
            cmd = f"mkdir -p '{mkdir_dir}' && {cmd}"
        r = subprocess.run(_sudo(cmd), shell=True, capture_output=True, timeout=15)
        os.unlink(tmp)
        return r.returncode == 0
    except Exception:
        return False


_SERVUI_TS_EXCLUDES_PATH = "/etc/servui/timeshift-excludes.json"


def _read_servui_ts_excludes() -> list[str] | None:
    """Read the serv-UI managed exclude list (source of truth for the UI)."""
    try:
        with open(_SERVUI_TS_EXCLUDES_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data.get("excludes"), list):
            return [str(x) for x in data["excludes"] if str(x).strip()]
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _write_servui_ts_excludes(excludes: list[str]) -> bool:
    payload = json.dumps({"excludes": excludes}, indent=2)
    return _write_file_root_safe(
        _SERVUI_TS_EXCLUDES_PATH, payload, mkdir_dir=os.path.dirname(_SERVUI_TS_EXCLUDES_PATH)
    )


def _default_ts_excludes() -> list[str]:
    """Build the default exclude list (home dirs, /root, non-root mounts)."""
    default_excludes: list[str] = []
    try:
        for u in os.listdir("/home"):
            if os.path.isdir(os.path.join("/home", u)) and not u.startswith("."):
                default_excludes.append(f"/home/{u}/**")
    except OSError:
        pass
    if not default_excludes:
        default_excludes = ["/home/user/**"]
    default_excludes.append("/root/**")
    try:
        root_src = subprocess.check_output(
            "findmnt -n -o SOURCE /", shell=True, text=True, timeout=5
        ).strip()
        for line in subprocess.check_output(
            "findmnt -n -o SOURCE,TARGET", shell=True, text=True, timeout=5
        ).splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] != root_src and parts[0].startswith("/dev/"):
                mp = parts[1].rstrip("/")
                if mp and mp != "/":
                    default_excludes.append(f"{mp}/**")
    except Exception:
        pass
    return default_excludes


@app.get("/api/timeshift/snapshots")
async def timeshift_snapshots():
    """List existing Timeshift snapshots."""
    r = await run_cmd("timeshift --list 2>&1", timeout=30)
    if r["returncode"] != 0 and "no snapshots found" not in r["stdout"].lower():
        raise HTTPException(status_code=500, detail=r["stderr"] or r["stdout"])

    snapshots = []
    for line in r["stdout"].splitlines():
        m = re.match(r"^\s*(\d+)\s+>\s+(\S+)\s+(\S+)\s*(.*)", line)
        if m:
            s_name = m.group(2).strip()
            snapshots.append({
                "id": int(m.group(1)),
                "name": s_name,
                "tags": m.group(3).strip(),
                "description": m.group(4).strip(),
                "size": _get_timeshift_snapshot_size(s_name),
            })

    # Read the currently configured exclude list from the Timeshift config.
    excludes: list[str] = []
    has_config = False
    cfg = {}
    try:
        with open("/etc/timeshift/timeshift.json", encoding="utf-8") as f:
            cfg = json.load(f)
            has_config = True
            excludes = cfg.get("exclude", [])
    except (OSError, json.JSONDecodeError):
        pass

    if not has_config:
        # First run: persist the defaults into the config file so that later
        # edits made in the UI are kept instead of being overwritten on reload.
        excludes = _default_ts_excludes()
        cfg = {
            "exclude": excludes,
            "do_first_run": "false",
            "btrfs_mode": "false",
            "exclude-apps": [],
        }
        _write_file_root_safe(
            "/etc/timeshift/timeshift.json", json.dumps(cfg, indent=2)
        )
        _write_servui_ts_excludes(excludes)
    elif not excludes and cfg.get("do_first_run") == "true":
        excludes = _default_ts_excludes()

    servui_excludes = _read_servui_ts_excludes()
    if servui_excludes is not None:
        excludes = servui_excludes

    return {"snapshots": snapshots, "excludes": excludes}


@app.post("/api/timeshift/excludes")
async def timeshift_save_excludes(req: Request):
    """Save the exclude list to /etc/timeshift/timeshift.json."""
    data = await _get_json(req)
    excludes_raw = data.get("excludes")

    excludes: list[str] = []
    if isinstance(excludes_raw, list):
        excludes = [str(x).strip() for x in excludes_raw if str(x).strip()]
    elif isinstance(excludes_raw, str) and excludes_raw.strip():
        excludes = [l.strip() for l in excludes_raw.splitlines() if l.strip()]

    cfg_path = "/etc/timeshift/timeshift.json"
    cfg: dict = {}
    try:
        with open(cfg_path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass

    cfg["exclude"] = excludes
    cfg.setdefault("do_first_run", "false")
    cfg.setdefault("btrfs_mode", "false")
    cfg.setdefault("exclude-apps", [])

    if not _write_file_root_safe(cfg_path, json.dumps(cfg, indent=2)):
        return {"success": False, "message": "設定ファイルの書き出しに失敗しました（権限を確認してください）"}
    _write_servui_ts_excludes(excludes)

    # Verify what actually landed on disk (external processes may rewrite it).
    try:
        with open(cfg_path, encoding="utf-8") as f:
            on_disk = json.load(f).get("exclude", [])
        print(f"[timeshift-save] written={excludes} on_disk_after={on_disk}", flush=True)
        if on_disk != excludes:
            return {"success": False, "message": f"保存後に設定が他プロセスによって書き換えられました: {on_disk}"}
    except (OSError, json.JSONDecodeError):
        pass

    return {"success": True, "message": "除外設定を保存しました"}


@app.post("/api/timeshift/create")
async def timeshift_create(req: Request):
    """Build the command to create a Timeshift snapshot (sent to terminal).

    The exclude paths are written into /etc/timeshift/timeshift.json first
    because the Timeshift CLI does not accept ``--exclude`` flags.
    """
    data = await _get_json(req)
    comment = (data.get("comment") or "").strip()
    excludes_raw = data.get("excludes")

    excludes: list[str] = []
    if isinstance(excludes_raw, list):
        excludes = [str(x).strip() for x in excludes_raw if str(x).strip()]
    elif isinstance(excludes_raw, str) and excludes_raw.strip():
        excludes = [l.strip() for l in excludes_raw.splitlines() if l.strip()]

    exclude_json = json.dumps(excludes)
    print(f"[timeshift-create] excludes from client: {exclude_json}", flush=True)
    _write_servui_ts_excludes(excludes)
    safe_comment = comment.replace("'", "'\\''") if comment else ""
    comment_arg = f" --comments '{safe_comment}'" if comment else ""

    # Detect root device for config and stdin fallback.
    r = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
    root_dev = r["stdout"].strip() if r["returncode"] == 0 else ""
    r_uuid = await run_cmd("findmnt -n -o UUID /", timeout=5)
    root_uuid = r_uuid["stdout"].strip() if r_uuid["returncode"] == 0 else ""

    script_body = (
        "#!/usr/bin/env python3\n"
        "import json, os\n"
        "c = '/etc/timeshift/timeshift.json'\n"
        "d = {}\n"
        "if os.path.isfile(c):\n"
        "    with open(c) as _f: d = json.load(_f)\n"
        f"d['exclude'] = {exclude_json}\n"
        "d['do_first_run'] = 'false'\n"
        "d.setdefault('btrfs_mode', 'false')\n"
        "d.setdefault('schedule_monthly', 'false')\n"
        "d.setdefault('schedule_weekly', 'false')\n"
        "d.setdefault('schedule_daily', 'false')\n"
        "d.setdefault('schedule_hourly', 'false')\n"
        "d.setdefault('schedule_boot', 'false')\n"
        "d.setdefault('count_monthly', '2')\n"
        "d.setdefault('count_weekly', '3')\n"
        "d.setdefault('count_daily', '5')\n"
        "d.setdefault('count_hourly', '6')\n"
        "d.setdefault('count_boot', '5')\n"
        "d.setdefault('exclude-apps', [])\n"
        f"d['backup_device_uuid'] = '{root_uuid}'\n"
        "with open(c, 'w') as _f: json.dump(d, _f, indent=2)\n"
    )

    # Write the helper script directly (no shell, no subprocess).
    ts_script = f"/tmp/ts_update_{os.getpid()}.py"
    try:
        with open(ts_script, "w", encoding="utf-8") as f:
            f.write(script_body)
    except OSError as e:
        return {"success": False, "message": f"ヘルパースクリプトの書き出しに失敗しました: {e}"}

    # Pipe device name to stdin as fallback for the backup-device prompt
    # (--yes only answers y/n questions, not the numbered device selector).
    stdin_arg = f"echo '{root_dev}' |" if root_dev else ""
    cmd = f"sudo python3 {ts_script} && {stdin_arg} sudo timeshift --create --yes{comment_arg}"

    label = comment or "(コメントなし)"
    return {"success": True, "cmd": cmd, "message": f"スナップショットを作成中: {label}"}


@app.post("/api/timeshift/restore")
async def timeshift_restore(req: Request):
    """Build the command to restore a Timeshift snapshot (sent to terminal)."""
    data = await _get_json(req)
    snapshot_id = data.get("snapshot_id")
    if snapshot_id is None:
        raise HTTPException(status_code=400, detail="snapshot_id is required")

    # Validate snapshot_id is a non-negative integer
    try:
        snapshot_id = int(snapshot_id)
        if snapshot_id < 0:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid snapshot_id")

    snapshots_resp = await timeshift_snapshots()
    snapshots = snapshots_resp["snapshots"]
    target = next((s for s in snapshots if s["id"] == snapshot_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"スナップショット {snapshot_id} が見つかりません")

    root_dev = ""
    r = await run_cmd("findmnt -n -o SOURCE /", timeout=5)
    if r["returncode"] == 0 and r["stdout"].strip():
        root_dev = r["stdout"].strip()

    target_arg = f" --target '{root_dev}'" if root_dev else ""
    cmd = f"sudo timeshift --restore --snapshot '{target['name']}'{target_arg} --skip-grub --scripted --yes"
    return {"success": True, "cmd": cmd, "message": f"スナップショット {snapshot_id} ({target['name']}) を復元します"}


@app.post("/api/timeshift/delete")
async def timeshift_delete(req: Request):
    """Delete a Timeshift snapshot."""
    data = await _get_json(req)
    snapshot_id = data.get("snapshot_id")
    if snapshot_id is None:
        raise HTTPException(status_code=400, detail="snapshot_id is required")

    try:
        snapshot_id = int(snapshot_id)
        if snapshot_id < 0:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid snapshot_id")

    snapshots_resp = await timeshift_snapshots()
    snapshots = snapshots_resp["snapshots"]
    target = next((s for s in snapshots if s["id"] == snapshot_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail=f"スナップショット {snapshot_id} が見つかりません")

    r = await run_cmd(
        _sudo(f"timeshift --delete --snapshot '{target['name']}' --yes"),
        timeout=300,
    )
    return {
        "success": r["returncode"] == 0,
        "message": f"スナップショット {snapshot_id} ({target['name']}) を削除しました" if r["returncode"] == 0 else f"削除に失敗しました: {r['stderr'] or r['stdout']}",
    }


@app.post("/api/servui/restart")
async def restart_servui():
    """Restart serv-UI service."""
    async def do_restart():
        await asyncio.sleep(0.5)
        await run_cmd(_sudo("systemctl restart servui"), timeout=15)
    asyncio.create_task(do_restart())
    return {"success": True, "stdout": "Restarting...", "errors": ""}


# --- serv-UI self-update ---
if os.getuid() == 0:
    SERVUI_UPDATE_LOG = "/var/log/servui-update.log"
    SERVUI_UPDATE_PID = "/run/servui-update.pid"
else:
    SERVUI_UPDATE_LOG = f"/tmp/servui-update-{os.getuid()}.log"
    SERVUI_UPDATE_PID = f"/tmp/servui-update-{os.getuid()}.pid"


@app.post("/api/system/selfupdate")
async def system_selfupdate():
    """Start serv-UI self-update as a detached process.

    The updater runs independently of this server, so it always finishes
    even though the files being replaced belong to the running service.
    Applying the new version (service restart) is done manually by the user.
    """
    try:
        with open(SERVUI_UPDATE_PID, encoding="utf-8") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return {"success": False, "message": "アップデートが既に実行中です"}
    except FileNotFoundError:
        pass
    except (ValueError, ProcessLookupError):
        pass
    except PermissionError:
        return {"success": False, "message": "アップデートが既に実行中です"}

    script = "\n".join([
        "set -e",
        f"echo $$ > {SERVUI_UPDATE_PID}",
        f"trap 'rm -f {SERVUI_UPDATE_PID}' EXIT",
        f"exec > {SERVUI_UPDATE_LOG} 2>&1",
        'echo "[serv-UI update] start $(date)"',
        "rm -rf /tmp/servui-update",
        "git clone --depth 1 https://github.com/hirogura/servui.git /tmp/servui-update",
        "bash /tmp/servui-update/setup.sh --no-restart",
        'echo "[serv-UI update] done $(date)"',
        "echo __SERVUI_UPDATE_DONE__",
    ]) + "\n"

    await asyncio.create_subprocess_exec(
        "/bin/bash", "-c", script,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )
    return {"success": True, "message": "アップデートを開始しました"}


@app.get("/api/system/selfupdate/status")
async def system_selfupdate_status():
    """Return current self-update progress (running flag + log tail)."""
    running = False
    try:
        with open(SERVUI_UPDATE_PID, encoding="utf-8") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        running = True
    except Exception:
        running = False

    log_tail = ""
    done = False
    try:
        with open(SERVUI_UPDATE_LOG, encoding="utf-8", errors="replace") as f:
            content = f.read()
        done = "__SERVUI_UPDATE_DONE__" in content
        log_tail = content[-3000:]
    except OSError:
        pass

    return {"running": running, "done": done, "log": log_tail}


@app.post("/api/system/reboot")
async def reboot_system():
    """Reboot the host system."""
    async def do_reboot():
        await asyncio.sleep(1.0)
        await run_cmd(f"{_sudo('/usr/bin/systemctl reboot')} || {_sudo('/usr/sbin/reboot')} || {_sudo('/sbin/reboot')} || {_sudo('reboot')}", timeout=15)
    asyncio.create_task(do_reboot())
    return {"success": True, "message": "システムを再起動しています..."}


@app.post("/api/system/shutdown")
async def shutdown_system():
    """Shut down the host system."""
    async def do_shutdown():
        await asyncio.sleep(1.0)
        await run_cmd(f"{_sudo('/usr/bin/systemctl poweroff')} || {_sudo('/usr/sbin/poweroff')} || {_sudo('/sbin/poweroff')} || {_sudo('poweroff')}", timeout=15)
    asyncio.create_task(do_shutdown())
    return {"success": True, "message": "システムをシャットダウンしています..."}


# ============================================================
# 8. GRUB Management (based on /iso/grub-manage.sh)
# ============================================================
GRUB_CUSTOM_FILE = "/etc/grub.d/40_custom"
GRUB_BACKUP_DIR = "/root/grub-backups"
GRUB_ONCE_BAK = "/var/tmp/grub-once-default-grub.bak"
GRUB_ONCE_RESTORE = "/usr/local/sbin/grub-menu-once-restore.sh"
GRUB_ONCE_UNIT = "/etc/systemd/system/grub-menu-once-restore.service"
_GRUB_ENTRY_RE = re.compile(r"""^\s*(?:menuentry|submenu)\s+['"]([^'"]*)['"]""")
_ISO_BOOT_CANDIDATES = [
    ("casper/vmlinuz", "casper/initrd", "casper"),
    ("casper/vmlinuz.efi", "casper/initrd.lz", "casper"),
    ("live/vmlinuz", "live/initrd.img", "live"),
    ("live/vmlinuz.efi", "live/initrd.img", "live"),
]


def _find_grub_cfg() -> str:
    for f in ("/boot/grub/grub.cfg", "/boot/grub2/grub.cfg", "/boot/efi/EFI/ubuntu/grub.cfg"):
        if os.path.isfile(f):
            return f
    return ""


async def _read_text(path: str) -> str | None:
    """Read a file, falling back to sudo cat when permission denied."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except PermissionError:
        res = await run_cmd(_sudo(f"cat {shlex.quote(path)}"))
        return res["stdout"] if res["returncode"] == 0 else None
    except OSError:
        return None


def _parse_grub_cfg(content: str) -> list[dict]:
    """Parse grub.cfg into entry list (mirrors grub-manage.sh parse_grub_cfg)."""
    lines = content.split("\n")

    custom_names: set[str] = set()
    in_cs = False
    begin_re = re.compile(r"^###\ BEGIN\ (.+)\ ###$")
    end_re = re.compile(r"^###\ END\ (.+)\ ###$")
    for line in lines:
        m = begin_re.match(line.strip())
        if m:
            in_cs = m.group(1).strip() == GRUB_CUSTOM_FILE
            continue
        m = end_re.match(line.strip())
        if m:
            in_cs = False
            continue
        if in_cs:
            em = _GRUB_ENTRY_RE.match(line)
            if em:
                custom_names.add(em.group(1))

    def src_of(name: str) -> str:
        return "custom" if name in custom_names else "auto"

    entries: list[dict] = []
    top_index = -1
    in_submenu = False
    sub_index = -1
    sub_top_index = -1

    for line in lines:
        if not in_submenu and re.match(r"^submenu\s", line):
            top_index += 1
            sub_top_index = top_index
            in_submenu = True
            sub_index = -1
            m = _GRUB_ENTRY_RE.match(line)
            name = m.group(1) if m else ""
            entries.append({"name": name, "class": "submenu_header",
                            "grub_id": str(top_index), "source": src_of(name)})
            continue
        if in_submenu and re.match(r"^}\s*$", line):
            in_submenu = False
            sub_top_index = -1
            continue
        if in_submenu and re.match(r"^\s+menuentry\s", line):
            sub_index += 1
            m = _GRUB_ENTRY_RE.match(line)
            name = m.group(1) if m else ""
            entries.append({"name": name, "class": "sub_entry",
                            "grub_id": f"{sub_top_index}>{sub_index}", "source": src_of(name)})
            continue
        if not in_submenu and re.match(r"^menuentry\s", line):
            top_index += 1
            m = _GRUB_ENTRY_RE.match(line)
            name = m.group(1) if m else ""
            entries.append({"name": name, "class": "toplevel",
                            "grub_id": str(top_index), "source": src_of(name)})
            continue

    return entries


async def _grub_settings() -> dict:
    result = {"default": None, "timeout": None,
              "saved_entry": None, "next_entry": None, "recordfail": None}
    txt = await _read_text("/etc/default/grub")
    if txt:
        for line in txt.splitlines():
            line = line.strip()
            if line.startswith("GRUB_DEFAULT="):
                result["default"] = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("GRUB_TIMEOUT="):
                result["timeout"] = line.split("=", 1)[1].strip().strip('"')

    for env_file in ("/boot/grub/grubenv", "/boot/grub2/grubenv"):
        if not os.path.isfile(env_file):
            continue
        res = await run_cmd(f"grub-editenv {shlex.quote(env_file)} list 2>/dev/null")
        for line in res["stdout"].splitlines():
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k == "saved_entry":
                result["saved_entry"] = v
            elif k == "next_entry":
                result["next_entry"] = v
            elif k == "recordfail":
                result["recordfail"] = v
        break
    return result


async def _efi_entries() -> list[dict]:
    which = await run_cmd("which efibootmgr")
    if which["returncode"] != 0:
        return []
    res = await run_cmd(_sudo("efibootmgr"), timeout=10)
    out = []
    for line in res["stdout"].splitlines():
        line = line.rstrip()
        if not line:
            continue
        out.append({"text": line, "active": line.startswith("*")})
    return out


async def _stale_grub_backups() -> list[str]:
    res = await run_cmd("find /etc/grub.d -maxdepth 1 -name '40_custom.bak.*' 2>/dev/null")
    return [l.strip() for l in res["stdout"].splitlines() if l.strip()]


@app.get("/api/grub/info")
async def grub_info():
    """Get GRUB config path, parsed entries, current settings, EFI entries."""
    cfg = _find_grub_cfg()
    content = await _read_text(cfg) if cfg else None
    entries = _parse_grub_cfg(content) if content else []
    return {
        "cfg_path": cfg,
        "custom_file": GRUB_CUSTOM_FILE,
        "entries": entries,
        "settings": await _grub_settings(),
        "efi": await _efi_entries(),
        "stale_backups": await _stale_grub_backups(),
        "next_menu_armed": os.path.isfile(GRUB_ONCE_BAK),
    }


@app.get("/api/grub/partitions")
async def grub_partitions():
    """List partitions / LVM logical volumes usable as ISO storage."""
    res = await run_cmd(
        "lsblk -J -o NAME,SIZE,FSTYPE,TYPE,LABEL,MOUNTPOINTS 2>/dev/null", timeout=10
    )
    parts: list[dict] = []
    try:
        data = json.loads(res["stdout"])

        def walk(dev):
            name = dev.get("name", "")
            dtype = dev.get("type", "")
            fstype = dev.get("fstype") or ""
            if not name.startswith("loop") and dtype in ("part", "lvm") and fstype != "LVM2_member":
                mps = dev.get("mountpoints")
                if isinstance(mps, list):
                    mp = next((m for m in mps if m), "")
                elif isinstance(mps, str):
                    mp = mps
                else:
                    mp = ""
                parts.append({
                    "name": name,
                    "size": dev.get("size", ""),
                    "fstype": fstype,
                    "label": (dev.get("label") or "").strip(),
                    "mountpoint": mp,
                    "is_lvm": dtype == "lvm",
                    "supported": fstype in ("ext2", "ext3", "ext4", "xfs"),
                })
            for c in dev.get("children") or []:
                walk(c)

        for d in data.get("blockdevices", []):
            walk(d)
    except (json.JSONDecodeError, KeyError, TypeError):
        pass
    return {"partitions": parts}


async def _resolve_part_device(name: str) -> tuple[str, bool] | None:
    """Resolve partition/LV name to device path. Returns (path, is_lvm) or None."""
    if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
        return None
    mapper = f"/dev/mapper/{name}"
    r1 = await run_cmd(f"test -b {shlex.quote(mapper)}")
    if r1["returncode"] == 0:
        return mapper, True
    dev = f"/dev/{name}"
    r2 = await run_cmd(f"test -b {shlex.quote(dev)}")
    if r2["returncode"] == 0:
        return dev, False
    return None


async def _detect_boot_paths(iso_path: str) -> tuple[str, str, str]:
    """Loop-mount an ISO read-only and detect vmlinuz/initrd paths (like _detect_boot_paths in the script).

    Returns (vmlinuz, initrd, boot_type) where boot_type is one of:
    'casper', 'live', 'clonezilla', or 'custom'.
    """
    tmp = f"/mnt/_servui_isoinspect_{os.getpid()}"
    await run_cmd(_sudo(f"mkdir -p {shlex.quote(tmp)}"))
    vmlinuz, initrd, boot_type = "UNKNOWN", "UNKNOWN", "custom"
    mounted = False
    try:
        mres = await run_cmd(
            _sudo(f"mount -o loop,ro {shlex.quote(iso_path)} {shlex.quote(tmp)}"), timeout=30
        )
        if mres["returncode"] == 0:
            mounted = True
            tests = " ; ".join(
                f"test -f {shlex.quote(tmp + '/' + c[0])} && echo {shlex.quote(c[0])}"
                for c in _ISO_BOOT_CANDIDATES
            )
            tres = await run_cmd(_sudo(tests), timeout=10)
            found = [l.strip() for l in tres["stdout"].splitlines() if l.strip()]
            if found:
                for c in _ISO_BOOT_CANDIDATES:
                    if c[0] == found[0]:
                        vmlinuz, initrd, boot_type = f"/{c[0]}", f"/{c[1]}", c[2]
                        break
                # Detect Clonezilla: live/vmlinuz + live/filesystem.squashfs
                if boot_type == "live":
                    cz_check = await run_cmd(
                        _sudo(f"test -f {shlex.quote(tmp + '/live/filesystem.squashfs')}"),
                        timeout=5,
                    )
                    if cz_check["returncode"] == 0:
                        boot_type = "clonezilla"
            else:
                fres = await run_cmd(
                    _sudo(f"find {shlex.quote(tmp)} -name 'vmlinuz*' 2>/dev/null | head -1"),
                    timeout=15,
                )
                vfound = fres["stdout"].strip()
                if vfound:
                    vmlinuz = vfound[len(tmp):] if vfound.startswith(tmp) else f"/{os.path.basename(vfound)}"
                    vdir = os.path.dirname(vfound)
                    ires = await run_cmd(
                        _sudo(f"find {shlex.quote(vdir)} -name 'initrd*' 2>/dev/null | head -1"),
                        timeout=15,
                    )
                    ifound = ires["stdout"].strip()
                    initrd = (ifound[len(tmp):] if ifound.startswith(tmp) else "") or "UNKNOWN"
                    boot_type = "custom"
    finally:
        if mounted:
            await run_cmd(_sudo(f"umount {shlex.quote(tmp)}"), timeout=15)
        await run_cmd(_sudo(f"rmdir {shlex.quote(tmp)} 2>/dev/null"))
    return vmlinuz, initrd, boot_type


@app.post("/api/grub/isos")
async def grub_scan_isos(req: Request):
    """Mount a partition temporarily, list ISO files with auto-detected boot paths."""
    data = await _get_json(req)
    name = (data.get("device") or "").strip()

    resolved = await _resolve_part_device(name)
    if not resolved:
        return {"success": False, "error": f"デバイス {name} が見つかりません"}
    part_dev, is_lvm = resolved

    cur_mp_res = await run_cmd(f"lsblk -no MOUNTPOINTS {shlex.quote(part_dev)} 2>/dev/null | head -1")
    cur_mp = cur_mp_res["stdout"].strip()
    tmp_mp = f"/mnt/_servui_isoboot_{os.getpid()}"
    mount_point = cur_mp
    mounted_here = False
    if not mount_point:
        mk = await run_cmd(_sudo(f"mkdir -p {shlex.quote(tmp_mp)}"))
        if mk["returncode"] != 0:
            return {"success": False, "error": "一時マウントポイントを作成できませんでした"}
        mres = await run_cmd(
            _sudo(f"mount {shlex.quote(part_dev)} {shlex.quote(tmp_mp)}"), timeout=30
        )
        if mres["returncode"] != 0:
            await run_cmd(_sudo(f"rmdir {shlex.quote(tmp_mp)} 2>/dev/null"))
            return {"success": False, "error": f"マウントに失敗しました: {mres['stderr'].strip()}"}
        mount_point = tmp_mp
        mounted_here = True

    try:
        fres = await run_cmd(
            f"find {shlex.quote(mount_point)} -maxdepth 2 -name '*.iso' 2>/dev/null", timeout=20
        )
        iso_full_paths = [l.strip() for l in fres["stdout"].splitlines() if l.strip()]
        isos = []
        for full in iso_full_paths:
            sz_res = await run_cmd(f"du -sh {shlex.quote(full)} 2>/dev/null | cut -f1")
            vmin, ird, btype = await _detect_boot_paths(full)
            isos.append({
                "path": full[len(mount_point):] or f"/{os.path.basename(full)}",
                "size": sz_res["stdout"].strip(),
                "vmlinuz": vmin,
                "initrd": ird,
                "boot_type": btype,
            })
        uuid_res = await run_cmd(f"blkid -s UUID -o value {shlex.quote(part_dev)} 2>/dev/null")
        return {
            "success": True,
            "device": part_dev,
            "is_lvm": is_lvm,
            "uuid": uuid_res["stdout"].strip(),
            "isos": isos,
        }
    finally:
        if mounted_here:
            await run_cmd(_sudo(f"umount {shlex.quote(mount_point)}"), timeout=20)
            await run_cmd(_sudo(f"rmdir {shlex.quote(mount_point)} 2>/dev/null"))


def _validate_grub_path(p: str) -> bool:
    if not p.startswith("/"):
        return False
    if ".." in p.split("/"):
        return False
    return not any(ch in p for ch in ('"', "'", "`", "\\", "\n", "\r", "$", ";", "&", "|", "<", ">"))


def _build_iso_grub_entry(menu_label: str, iso_rel: str, vmlinuz: str, initrd: str,
                          boot_type: str, *, is_lvm: bool, lvm_name: str, part_uuid: str) -> str:
    """Generate a menuentry block (same format as grub-manage.sh).

    For Clonezilla ISOs (boot_type='clonezilla'), adds toram and ocs_* parameters
    so the live system loads into RAM and the ISO partition is freed for read-write
    access by Clonezilla.
    """
    if boot_type == "clonezilla":
        params = (
            "boot=live union=overlay username=user config components quiet noswap noeject "
            "nofastboot ip=frommedia locales=en_US.UTF-8 keyboard-layouts=NONE toram "
            "ocs_lang=en_US.UTF-8 ocs_live_batch=\"yes\" ocs_final_action=reboot "
            "findiso=$isofile"
        )
    elif boot_type == "casper":
        params = "boot=casper iso-scan/filename=$isofile quiet splash ---"
    elif boot_type == "live":
        params = "boot=live iso-scan/filename=$isofile quiet splash"
    else:
        params = "iso-scan/filename=$isofile quiet splash"

    if is_lvm:
        return (
            f'\nmenuentry "{menu_label} (ISO Loop Boot)" {{\n'
            "    insmod part_gpt\n"
            "    insmod lvm\n"
            "    insmod ext2\n"
            "    insmod loopback\n"
            "    insmod iso9660\n"
            f"    set root='(lvm/{lvm_name})'\n"
            f'    set isofile="{iso_rel}"\n'
            "    loopback loop $isofile\n"
            f"    linux  (loop){vmlinuz} {params}\n"
            f"    initrd (loop){initrd}\n"
            "}\n"
        )
    return (
        f'\nmenuentry "{menu_label} (ISO Loop Boot)" {{\n'
        "    insmod part_gpt\n"
        "    insmod ext2\n"
        "    insmod loopback\n"
        "    insmod iso9660\n"
        f"    search --no-floppy --fs-uuid --set=isodev {part_uuid}\n"
        f'    set isofile="{iso_rel}"\n'
        "    loopback loop ($isodev)$isofile\n"
        f"    linux  (loop){vmlinuz} {params}\n"
        f"    initrd (loop){initrd}\n"
        "}\n"
    )


async def _backup_grub_custom() -> str | None:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = f"{GRUB_BACKUP_DIR}/40_custom.bak.{ts}"
    await run_cmd(_sudo(f"mkdir -p {shlex.quote(GRUB_BACKUP_DIR)}"))
    res = await run_cmd(_sudo(f"cp {shlex.quote(GRUB_CUSTOM_FILE)} {shlex.quote(dst)}"))
    return dst if res["returncode"] == 0 else None


async def _append_to_custom(block: str) -> tuple[bool, str]:
    try:
        with open(GRUB_CUSTOM_FILE, "a", encoding="utf-8") as f:
            f.write(block)
        return True, ""
    except PermissionError:
        fd, tmp = tempfile.mkstemp(prefix="servui_grub_", dir="/tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(block)
        try:
            res = await run_cmd(
                _sudo(f"sh -c 'cat {shlex.quote(tmp)} >> {shlex.quote(GRUB_CUSTOM_FILE)}'")
            )
            return res["returncode"] == 0, res["stderr"]
        finally:
            os.unlink(tmp)


async def _write_root_file(path: str, content: str) -> tuple[bool, str]:
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return True, ""
    except PermissionError:
        fd, tmp = tempfile.mkstemp(prefix="servui_grub_", dir="/tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        try:
            res = await run_cmd(_sudo(f"cp {shlex.quote(tmp)} {shlex.quote(path)}"))
            return res["returncode"] == 0, res["stderr"]
        finally:
            os.unlink(tmp)


@app.post("/api/grub/entries/add")
async def grub_entries_add(req: Request):
    """Append ISO loop boot entries to 40_custom, backup first, then update-grub."""
    data = await _get_json(req)
    name = (data.get("device") or "").strip()
    isos = data.get("isos") or []
    if not isinstance(isos, list) or not isos:
        raise HTTPException(status_code=400, detail="isos are required")

    resolved = await _resolve_part_device(name)
    if not resolved:
        return {"success": False, "message": f"デバイス {name} が見つかりません"}
    part_dev, is_lvm = resolved
    lvm_name = os.path.basename(part_dev) if is_lvm else ""

    part_uuid = ""
    if not is_lvm:
        ures = await run_cmd(f"blkid -s UUID -o value {shlex.quote(part_dev)} 2>/dev/null")
        part_uuid = ures["stdout"].strip()
        if not part_uuid:
            return {"success": False, "message": "パーティションのUUIDを取得できませんでした"}

    cleaned: list[tuple[str, str, str, str]] = []
    for iso in isos:
        iso_rel = str(iso.get("path", "")).strip()
        vmin = str(iso.get("vmlinuz", "")).strip()
        ird = str(iso.get("initrd", "")).strip()
        btype = str(iso.get("boot_type", "custom")).strip() or "custom"
        if not _validate_grub_path(iso_rel) or not _validate_grub_path(vmin) or not _validate_grub_path(ird):
            return {"success": False, "message": f"無効なパスが含まれています: {iso_rel}"}
        cleaned.append((iso_rel, vmin, ird, btype))

    t = await run_cmd(f"test -f {shlex.quote(GRUB_CUSTOM_FILE)}")
    if t["returncode"] != 0:
        return {"success": False, "message": f"{GRUB_CUSTOM_FILE} が見つかりません"}

    bak = await _backup_grub_custom()
    if not bak:
        return {"success": False, "message": "バックアップの作成に失敗しました"}

    blocks = []
    added_labels = []
    for iso_rel, vmin, ird, btype in cleaned:
        menu_label = re.sub(r"[\"'`\\$;&|<>\n\r]", "", os.path.basename(iso_rel))
        if menu_label.endswith(".iso"):
            menu_label = menu_label[:-4]
        blocks.append(_build_iso_grub_entry(
            menu_label, iso_rel, vmin, ird, btype,
            is_lvm=is_lvm, lvm_name=lvm_name, part_uuid=part_uuid,
        ))
        added_labels.append(menu_label)

    ok, err = await _append_to_custom("\n".join(blocks))
    if not ok:
        return {"success": False, "message": f"{GRUB_CUSTOM_FILE}への追記に失敗しました: {err}"}

    upd = await run_cmd(_sudo("update-grub"), timeout=180)
    tail_lines = [l for l in upd["stdout"].splitlines() if l.strip()][-8:]
    msg = f"{len(added_labels)}件のISOループブートエントリーを追加しました ({', '.join(added_labels)})\nバックアップ: {bak}"
    if upd["returncode"] == 0:
        msg += "\nupdate-grub 完了"
    else:
        msg += "\n警告: update-grubでエラーが発生しました。ターミナルで sudo update-grub を確認してください。"
    return {"success": True, "message": msg, "output": "\n".join(tail_lines)}


def _remove_menuentry_block(content: str, name: str, occurrence: int) -> str:
    """Remove the Nth occurrence of a menuentry block by brace depth tracking."""
    out = []
    skip = False
    depth = 0
    match_count = 0
    for line in content.split("\n"):
        if not skip and "menuentry" in line and name in line:
            match_count += 1
            if match_count == occurrence:
                skip = True
                depth = 0
                continue
        if skip:
            for ch in line:
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth <= 0:
                        skip = False
                        break
            continue
        out.append(line)
    return "\n".join(out)


@app.post("/api/grub/entries/delete")
async def grub_entries_delete(req: Request):
    """Delete custom (40_custom-derived) entries by index, backup first, then update-grub."""
    data = await _get_json(req)
    indices = data.get("indices")
    if not isinstance(indices, list) or not indices:
        raise HTTPException(status_code=400, detail="indices are required")

    cfg = _find_grub_cfg()
    if not cfg:
        return {"success": False, "message": "grub.cfgが見つかりません"}
    content_cfg = await _read_text(cfg)
    if content_cfg is None:
        return {"success": False, "message": "grub.cfgを読み取れませんでした"}
    entries = _parse_grub_cfg(content_cfg)

    deletable = {i for i, e in enumerate(entries)
                 if e["source"] == "custom" and e["class"] != "submenu_header"}
    try:
        req_idx = [int(i) for i in indices]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="invalid indices")
    if any(i < 0 or i >= len(entries) or i not in deletable for i in req_idx):
        return {"success": False, "message": "削除できないエントリーが含まれています（40_custom由来のみ削除可能）"}

    occ_map: dict[str, list[int]] = {}
    for num in req_idx:
        tname = entries[num]["name"]
        occ = 0
        for i, e in enumerate(entries):
            if e["source"] != "custom" or e["class"] == "submenu_header":
                continue
            if e["name"] == tname:
                occ += 1
            if i == num:
                break
        occ_map.setdefault(tname, []).append(occ)

    content = await _read_text(GRUB_CUSTOM_FILE)
    if content is None:
        return {"success": False, "message": f"{GRUB_CUSTOM_FILE} を読み取れませんでした"}

    bak = await _backup_grub_custom()
    if not bak:
        return {"success": False, "message": "バックアップの作成に失敗しました"}

    removed = []
    for tname, occs in occ_map.items():
        for occ in sorted(set(occs), reverse=True):
            content = _remove_menuentry_block(content, tname, occ)
            removed.append(f"{tname}（{occ}番目）")

    ok, err = await _write_root_file(GRUB_CUSTOM_FILE, content)
    if not ok:
        return {"success": False, "message": f"{GRUB_CUSTOM_FILE}の更新に失敗しました: {err}"}

    upd = await run_cmd(_sudo("update-grub"), timeout=180)
    tail_lines = [l for l in upd["stdout"].splitlines() if l.strip()][-8:]
    msg = "削除しました: " + ", ".join(removed) + f"\nバックアップ: {bak}"
    msg += "\nupdate-grub 完了" if upd["returncode"] == 0 else "\n警告: update-grubでエラーが発生しました"
    return {"success": True, "message": msg, "output": "\n".join(tail_lines)}


@app.post("/api/grub/cleanup-backups")
async def grub_cleanup_backups():
    """Remove stale 40_custom.bak.* files from /etc/grub.d (they resurrect deleted entries)."""
    stales = await _stale_grub_backups()
    if not stales:
        return {"success": True, "message": "削除すべき古いバックアップはありません"}
    files = " ".join(shlex.quote(f) for f in stales)
    res = await run_cmd(_sudo(f"rm -f {files}"))
    if res["returncode"] != 0:
        return {"success": False, "message": f"削除に失敗しました: {res['stderr']}"}
    return {"success": True, "message": f"{len(stales)}件の古いバックアップを削除しました"}


_GRUB_ONCE_RESTORE_SCRIPT = """#!/bin/bash
set -euo pipefail
BAK="/var/tmp/grub-once-default-grub.bak"
if [ -f "$BAK" ]; then
  cp "$BAK" /etc/default/grub
  if update-grub >/dev/null 2>&1; then
    rm -f "$BAK"
  fi
fi
if [ ! -f "$BAK" ]; then
  systemctl disable grub-menu-once-restore.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/grub-menu-once-restore.service
  systemctl daemon-reload >/dev/null 2>&1 || true
fi
"""


def _grub_once_unit_content() -> str:
    return (
        "[Unit]\n"
        "Description=Restore GRUB default settings after one-time menu display\n"
        "After=local-fs.target\n"
        f"ConditionPathExists={GRUB_ONCE_BAK}\n"
        "\n"
        "[Service]\n"
        "Type=oneshot\n"
        f"ExecStart={GRUB_ONCE_RESTORE}\n"
        "\n"
        "[Install]\n"
        "WantedBy=multi-user.target\n"
    )


@app.post("/api/grub/next-boot-menu")
async def grub_next_boot_menu():
    """Show the GRUB menu only at next boot (ports next-grubmenu.sh).

    Backs up /etc/default/grub, sets GRUB_TIMEOUT_STYLE=menu / GRUB_TIMEOUT=5,
    runs update-grub, and installs a oneshot systemd unit that restores the
    original settings after the next boot.
    """
    w = await run_cmd("which update-grub")
    if w["returncode"] != 0:
        return {"success": False, "message": "update-grub が見つかりません。この環境では利用できません。"}

    # Backup current settings (keep the first backup so original settings are preserved)
    if not os.path.isfile(GRUB_ONCE_BAK):
        bres = await run_cmd(
            _sudo(f"cp {shlex.quote('/etc/default/grub')} {shlex.quote(GRUB_ONCE_BAK)}")
        )
        if bres["returncode"] != 0:
            return {"success": False, "message": f"/etc/default/grubのバックアップに失敗しました: {bres['stderr']}"}

    # Rewrite GRUB_TIMEOUT_STYLE / GRUB_TIMEOUT
    txt = await _read_text("/etc/default/grub")
    if txt is None:
        return {"success": False, "message": "/etc/default/grub を読み取れませんでした"}
    new_lines = []
    has_style = False
    has_timeout = False
    for line in txt.split("\n"):
        if line.startswith("GRUB_TIMEOUT_STYLE="):
            new_lines.append("GRUB_TIMEOUT_STYLE=menu")
            has_style = True
        elif line.startswith("GRUB_TIMEOUT="):
            new_lines.append("GRUB_TIMEOUT=5")
            has_timeout = True
        else:
            new_lines.append(line)
    if not has_style:
        new_lines.append("GRUB_TIMEOUT_STYLE=menu")
    if not has_timeout:
        new_lines.append("GRUB_TIMEOUT=5")
    content = "\n".join(new_lines)
    if not content.endswith("\n"):
        content += "\n"
    ok, err = await _write_root_file("/etc/default/grub", content)
    if not ok:
        return {"success": False, "message": f"/etc/default/grub の変更に失敗しました: {err}"}

    upd = await run_cmd(_sudo("update-grub"), timeout=180)
    if upd["returncode"] != 0:
        await run_cmd(_sudo(f"cp {shlex.quote(GRUB_ONCE_BAK)} {shlex.quote('/etc/default/grub')}"))
        await run_cmd(_sudo(f"rm -f {shlex.quote(GRUB_ONCE_BAK)}"))
        return {
            "success": False,
            "message": "update-grubに失敗したため、/etc/default/grub を元に戻しました",
        }

    # Install restore script and systemd unit
    ok1, err1 = await _write_root_file(GRUB_ONCE_RESTORE, _GRUB_ONCE_RESTORE_SCRIPT)
    ok2, err2 = await _write_root_file(GRUB_ONCE_UNIT, _grub_once_unit_content())
    if not (ok1 and ok2):
        return {"success": False, "message": f"復元スクリプト/unitの作成に失敗しました: {err1} {err2}"}
    await run_cmd(_sudo(f"chmod 700 {shlex.quote(GRUB_ONCE_RESTORE)}"))
    await run_cmd(_sudo("systemctl daemon-reload"))
    en = await run_cmd(_sudo("systemctl enable grub-menu-once-restore.service"))

    msg = (
        "設定完了。次回の起動時のみ GRUB メニューが 5 秒間表示されます。\n"
        "その次の起動からは元の設定（メニュー非表示）に自動で戻ります。"
    )
    if en["returncode"] != 0:
        msg += "\n警告: systemdユニットの有効化に失敗しました: " + en["stderr"].strip()
    return {"success": True, "message": msg}


_iso_dl_state: dict = {
    "running": False, "success": None, "cancelled": False,
    "log": "", "filename": "", "path": "", "total": None,
}
_iso_dl_lock = asyncio.Lock()
_iso_dl_proc: asyncio.subprocess.Process | None = None


def _reset_iso_dl_state(**kw) -> None:
    _iso_dl_state.clear()
    _iso_dl_state.update({
        "running": False, "success": None, "cancelled": False,
        "log": "", "filename": "", "path": "", "total": None,
    }, **kw)


def _probe_content_length(url: str) -> int | None:
    """Best-effort Content-Length lookup for progress display (None if unknown)."""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "servui"})
        with urllib.request.urlopen(req, timeout=5, context=_SSL_UNVERIFIED) as resp:
            cl = resp.headers.get("Content-Length")
            return int(cl) if cl else None
    except Exception:
        return None


async def _iso_download_worker(proc: asyncio.subprocess.Process, dest: str) -> None:
    global _iso_dl_proc
    try:
        _, stderr = await proc.communicate()
        rc = proc.returncode
        async with _iso_dl_lock:
            if rc == 0:
                _iso_dl_state["success"] = True
                _iso_dl_state["log"] = ""
            else:
                _iso_dl_state["success"] = False
                if _iso_dl_state["cancelled"]:
                    _iso_dl_state["log"] = "キャンセルしました"
                else:
                    err_lines = [l for l in stderr.decode("utf-8", errors="replace").splitlines() if l.strip()]
                    _iso_dl_state["log"] = err_lines[-1] if err_lines else f"wget exit code {rc}"
                await run_cmd(_sudo(f"rm -f {shlex.quote(dest)}"))
            _iso_dl_state["running"] = False
    except Exception as e:
        async with _iso_dl_lock:
            _iso_dl_state["success"] = False
            _iso_dl_state["log"] = str(e)
            _iso_dl_state["running"] = False
    finally:
        _iso_dl_proc = None


_UBUNTU_RELEASES_BASE = "https://releases.ubuntu.com"


@app.get("/api/grub/ubuntu-versions")
async def ubuntu_versions():
    """List available Ubuntu release versions from releases.ubuntu.com."""
    url = f"{_UBUNTU_RELEASES_BASE}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "servui"})
        resp = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req, timeout=15, context=_SSL_UNVERIFIED)
        )
        html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"releases.ubuntu.comへの接続に失敗しました: {e}")
    versions = []
    for m in re.finditer(r'<a\s+href="(\d+\.\d+(?:\.\d+)?)/"[^>]*>\d+\.\d+(?:\.\d+)?/</a>.*?Ubuntu\s+([\d.]+(?:\s+LTS)?)\s*\(([^)]+)\)', html):
        folder = m.group(1)
        label = m.group(2).strip()
        codename = (m.group(3) or "").strip()
        display = f"Ubuntu {label}" + (f" ({codename})" if codename else "")
        versions.append({"name": folder, "display": display})
    seen = set()
    unique = []
    for v in versions:
        if v["name"] not in seen:
            seen.add(v["name"])
            unique.append(v)
    def _ver_key(v):
        parts = re.split(r"[.]", v["name"])
        return [int(p) for p in parts if p.isdigit()]
    unique.sort(key=_ver_key, reverse=True)
    return {"versions": unique}


@app.get("/api/grub/ubuntu-files")
async def ubuntu_files(version: str):
    """List ISO files for a given Ubuntu release version."""
    if not re.match(r"^\d+\.\d+(?:\.\d+)?$", version):
        raise HTTPException(status_code=400, detail="不正なバージョン指定です")
    url = f"{_UBUNTU_RELEASES_BASE}/{version}/"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "servui"})
        resp = await asyncio.to_thread(
            lambda: urllib.request.urlopen(req, timeout=15, context=_SSL_UNVERIFIED)
        )
        html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"releases.ubuntu.comへの接続に失敗しました: {e}")
    files = []
    for m in re.finditer(r'<a\s+href="(ubuntu-[^"]+\.iso)"[^>]*>\s*\1\s*</a>', html):
        name = m.group(1)
        download_url = f"{_UBUNTU_RELEASES_BASE}/{version}/{name}"
        files.append({"name": name, "download_url": download_url})
    files.sort(key=lambda f: f["name"])
    return {"files": files}


@app.post("/api/grub/iso-download")
async def grub_iso_download(req: Request):
    """Start downloading an ISO image from a direct URL into /iso using wget (background)."""
    global _iso_dl_proc
    data = await _get_json(req)
    url = (data.get("url") or "").strip()
    if not url:
        return {"success": False, "message": "ISOイメージのURLを入力してください"}
    if not re.match(r"^https?://", url):
        return {"success": False, "message": "http:// または https:// で始まるURLを入力してください"}
    if any(ch in url for ch in ('"', "'", "`", "\\", "\n", "\r", "$", ";", "&", "|", "<", ">")):
        return {"success": False, "message": "URLに使用できない文字が含まれています"}

    w = await run_cmd("which wget")
    if w["returncode"] != 0:
        return {"success": False, "message": "wget が見つかりません"}

    fname = os.path.basename(urllib.parse.urlparse(url).path)
    if not fname.lower().endswith(".iso"):
        return {"success": False, "message": "URLの末尾が.isoとなっている直接リンクを指定してください"}
    if any(ch in fname for ch in ('"', "'", "`", "\\", "$", ";", "&", "|", "<", ">")):
        return {"success": False, "message": "ファイル名に使用できない文字が含まれています"}

    mnt = await run_cmd("findmnt -n --target /iso", timeout=5)
    if mnt["returncode"] != 0:
        return {"success": False, "message": "/iso に保存用パーティションがマウントされていません"}

    dest = f"/iso/{fname}"
    if os.path.exists(dest):
        return {"success": False, "message": f"同名のファイルが既に存在します: {fname}"}

    total = await asyncio.to_thread(_probe_content_length, url)

    async with _iso_dl_lock:
        if _iso_dl_state["running"]:
            return {"success": False, "message": "ダウンロードが既に実行中です"}
        proc = await asyncio.create_subprocess_shell(
            _sudo(f"wget -q --tries=3 --timeout=60 -O {shlex.quote(dest)} {shlex.quote(url)}"),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        _iso_dl_proc = proc
        _reset_iso_dl_state(running=True, filename=fname, path=dest, total=total)
        asyncio.create_task(_iso_download_worker(proc, dest))
    return {"success": True, "filename": fname}


@app.get("/api/grub/iso-download/status")
async def grub_iso_download_status():
    """Current state of the background ISO download."""
    st = dict(_iso_dl_state)
    size = 0
    try:
        if st["path"] and os.path.isfile(st["path"]):
            size = os.path.getsize(st["path"])
    except OSError:
        size = 0
    st["size"] = size
    st.pop("path", None)
    return st


@app.post("/api/grub/iso-download/cancel")
async def grub_iso_download_cancel():
    """Abort the running ISO download (kills the wget process group)."""
    async with _iso_dl_lock:
        if not _iso_dl_state["running"]:
            return {"success": False, "message": "実行中のダウンロードはありません"}
        _iso_dl_state["cancelled"] = True
        proc = _iso_dl_proc
    if proc is not None and proc.returncode is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    return {"success": True, "message": "ダウンロードをキャンセルしています..."}


# ============================================================
# 9. serv-UI Fleet Management (Tailnet-wide bulk management)
# ============================================================
FLEET_PINS_FILE = Path(__file__).parent / "fleet_pins.json"
SERVUI_SERVE_PORT = 3355
_SSL_UNVERIFIED = ssl._create_unverified_context()
_FQDN_RE = re.compile(
    r"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$"
)
_TS_IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def _load_fleet_pins() -> list[dict]:
    """Load pinned serv-UI hosts from fleet_pins.json."""
    try:
        with open(FLEET_PINS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [p for p in data if isinstance(p, dict) and p.get("key")]
    except (OSError, json.JSONDecodeError):
        pass
    return []


def _save_fleet_pins(pins: list[dict]) -> None:
    tmp = FLEET_PINS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(pins, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(FLEET_PINS_FILE)


def _fleet_pin_key(fqdn: str, ips: list[str]) -> str | None:
    """Stable key for a node: FQDN when available, otherwise Tailscale IP."""
    fqdn = (fqdn or "").strip().rstrip(".").lower()
    if fqdn:
        return fqdn
    for ip in ips or []:
        if _TS_IP_RE.match(str(ip)):
            return str(ip)
    return None


def _fetch_remote_system_info_sync(candidates: list[tuple[str, ssl.SSLContext | None]],
                                   timeout: float = 3.0) -> dict | None:
    """Try candidate URLs in order; return parsed /api/system/info JSON of first success."""
    for url, ctx in candidates:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "servui-fleet"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                if resp.status != 200:
                    continue
                return json.loads(resp.read().decode("utf-8", errors="replace"))
        except Exception:
            continue
    return None


async def _fetch_remote_system_info(fqdn: str, ips: list[str] | None = None,
                                    port: int = SERVUI_SERVE_PORT) -> dict | None:
    candidates = []
    if fqdn:
        # LE cert issued for <host>.<tailnet>.ts.net is publicly trusted
        candidates.append((f"https://{fqdn}:{port}/api/system/info", None))
    for ip in (ips or []):
        if not _TS_IP_RE.match(str(ip)):
            continue
        # Fallback: direct Tailscale IP (cert is issued for the FQDN -> skip verify)
        candidates.append((f"https://{ip}:{port}/api/system/info", _SSL_UNVERIFIED))
    if not candidates:
        return None
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _fetch_remote_system_info_sync, candidates)


def _extract_fleet_info(info: dict | None) -> dict | None:
    """Pick the fields shown on the bulk-management page from /api/system/info."""
    if not isinstance(info, dict):
        return None
    cpu = info.get("cpu") or {}
    mem = info.get("memory") or {}
    disk = info.get("disk") or {}
    return {
        "cpu_percent": cpu.get("percent"),
        "cpu_temp": cpu.get("temp"),
        "mem_percent": mem.get("percent"),
        "mem_used": mem.get("used"),
        "mem_total": mem.get("total"),
        "disk_percent": disk.get("percent"),
        "disk_used": disk.get("used"),
        "disk_total": disk.get("total"),
        "os": info.get("os"),
        "uptime_seconds": info.get("uptime_seconds"),
        "reported_hostname": info.get("hostname"),
    }


def _fleet_node_from_ts_entry(entry: dict) -> dict | None:
    """Convert a tailscale status Self/Peer entry into a fleet node dict."""
    if not isinstance(entry, dict):
        return None
    dns = (entry.get("DNSName") or "").strip().rstrip(".")
    ips = [str(i) for i in (entry.get("TailscaleIPs") or [])]
    short = (entry.get("HostName") or "").strip() or (dns.split(".")[0] if dns else "")
    key = _fleet_pin_key(dns, ips)
    if not key:
        return None
    online = entry.get("Online")
    if entry.get("Self") is True:
        online = True
    return {
        "key": key,
        "hostname": short or key,
        "fqdn": dns,
        "ips": ips,
        "online": bool(online),
    }


async def _probe_fleet_node(node: dict, semaphore: asyncio.Semaphore) -> dict:
    """Probe one node's serv-UI and collect its system info."""
    display_host = node["fqdn"] or (node["ips"][0] if node["ips"] else node["key"])
    out = {
        **node,
        "port": SERVUI_SERVE_PORT,
        "url": f"https://{display_host}:{SERVUI_SERVE_PORT}/",
        "reachable": False,
        "info": None,
    }
    raw = None
    async with semaphore:
        try:
            raw = await _fetch_remote_system_info(node.get("fqdn", ""), node.get("ips"))
        except Exception:
            raw = None
    if raw is not None:
        out["reachable"] = True
        out["info"] = _extract_fleet_info(raw)
    return out


async def _probe_pinned_nodes(pins: list[dict]) -> list[dict]:
    sem = asyncio.Semaphore(8)

    async def probe(pin: dict) -> dict:
        node = {
            "key": pin["key"],
            "hostname": pin.get("hostname") or pin["key"].split(".")[0],
            "fqdn": pin.get("fqdn", ""),
            "ips": pin.get("ips") or [],
            "online": True,
            "is_self": False,
        }
        return await _probe_fleet_node(node, sem)

    return list(await asyncio.gather(*[probe(p) for p in pins]))


@app.get("/api/fleet/detect")
async def fleet_detect():
    """Detect serv-UI instances running in the Tailnet.

    Lists all online peers (plus this host), probes their serv-UI
    (https://<node>:3355) and collects live stats from reachable ones.
    """
    ts = await run_cmd("tailscale status --json", timeout=10)
    if ts["returncode"] != 0:
        return {"success": False,
                "error": f"tailscale status の取得に失敗しました: {ts['stderr'].strip() or 'Tailscaleが利用できません'}"}
    try:
        data = json.loads(ts["stdout"])
    except json.JSONDecodeError:
        return {"success": False, "error": "tailscale status の解析に失敗しました"}

    nodes = []
    self_node = _fleet_node_from_ts_entry(data.get("Self") or {})
    if self_node:
        self_node["is_self"] = True
        nodes.append(self_node)
    for peer in (data.get("Peer") or {}).values():
        n = _fleet_node_from_ts_entry(peer)
        if n and n["online"]:
            nodes.append(n)

    pinned_keys = {p["key"] for p in _load_fleet_pins()}
    for n in nodes:
        n["pinned"] = n["key"] in pinned_keys

    sem = asyncio.Semaphore(8)
    results = list(await asyncio.gather(*[_probe_fleet_node(n, sem) for n in nodes]))
    results.sort(key=lambda r: (not r["reachable"], r["hostname"].lower()))
    running = sum(1 for r in results if r["reachable"])
    return {"success": True, "nodes": results, "count": running}


@app.get("/api/fleet/pins")
async def fleet_pins_list():
    """Return pinned serv-UI hosts with live stats."""
    pins = _load_fleet_pins()
    results = await _probe_pinned_nodes(pins)
    order = {p["key"]: i for i, p in enumerate(pins)}
    results.sort(key=lambda r: order.get(r["key"], len(order)))
    return {"pins": results}


@app.post("/api/fleet/pin")
async def fleet_pins_add(req: Request):
    """Pin a detected serv-UI host (persisted in fleet_pins.json)."""
    data = await _get_json(req)
    fqdn = (data.get("fqdn") or "").strip().rstrip(".").lower()
    ips = [str(i) for i in (data.get("ips") or [])]
    key = _fleet_pin_key(fqdn, ips)
    if not key or (not fqdn and not any(_TS_IP_RE.match(i) for i in ips)):
        raise HTTPException(status_code=400, detail="fqdn or tailscale IP is required")

    hostname = (data.get("hostname") or "").strip() or key.split(".")[0]
    pins = _load_fleet_pins()
    if any(p["key"] == key for p in pins):
        return {"success": True, "message": "既にピン留めされています"}
    pins.append({"key": key, "fqdn": fqdn, "hostname": hostname,
                 "ips": [i for i in ips if _TS_IP_RE.match(i)]})
    _save_fleet_pins(pins)
    return {"success": True, "message": f"{hostname} をピン留めしました"}


@app.post("/api/fleet/unpin")
async def fleet_pins_remove(req: Request):
    """Unpin a serv-UI host."""
    data = await _get_json(req)
    key = (data.get("key") or "").strip().rstrip(".").lower()
    if not key:
        raise HTTPException(status_code=400, detail="key is required")
    pins = _load_fleet_pins()
    remaining = [p for p in pins if p["key"] != key]
    if len(remaining) == len(pins):
        return {"success": True, "message": "ピン留めされていません"}
    _save_fleet_pins(remaining)
    return {"success": True, "message": "ピン留めを解除しました"}


# ============================================================
# Main HTML page
# ============================================================
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=3355,
        log_level="info",
    )
