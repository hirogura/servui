#!/usr/bin/env python3
"""
serv-UI - Web-based Server Management Interface
A lightweight alternative to Webmin, designed to work with Tailscale serve.
"""

import asyncio
import fcntl
import json
import os
import pty
import pwd
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
from datetime import datetime
from pathlib import Path

import psutil
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

IS_ROOT = os.getuid() == 0

app = FastAPI(title="serv-UI", version="1.1.0")

# Static files and templates
BASE_DIR = Path(__file__).parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


def _sudo(cmd: str) -> str:
    """Prefix command with sudo when not running as root."""
    if IS_ROOT:
        return cmd
    return f"sudo {cmd}"


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


@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket):
    """WebSocket-based terminal using PTY for clean terminal emulation.
    Uses setpriv when running as root (like selfcode), falls back to sudo+su."""
    await websocket.accept()

    target_user, target_home, target_shell = get_primary_user()
    is_root = os.getuid() == 0
    cur_user_name = pwd.getpwuid(os.getuid()).pw_name
    env = _build_term_env(target_user, target_home, target_shell)

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child process: stdin, stdout, and stderr are automatically connected to slave PTY
        try:
            cur_uid = os.getuid()
            cur_user = pwd.getpwuid(cur_uid).pw_name if pwd.getpwuid(cur_uid) else ""

            if cur_uid == 0 and cur_user != target_user:
                # Running as root: use setpriv for clean user switch (like selfcode)
                # setpriv replaces the process image directly, so job control works correctly
                os.execvpe(
                    "/usr/bin/setpriv",
                    [
                        "/usr/bin/setpriv",
                        f"--reuid={target_user}",
                        f"--regid={target_user}",
                        "--init-groups",
                        "--",
                        target_shell,
                        "-l",
                    ],
                    env,
                )
            elif cur_user != target_user:
                # Non-root: switch via sudo + su (su is allowed in sudoers)
                os.execvpe(
                    "/usr/bin/sudo",
                    ["/usr/bin/sudo", "/usr/bin/su", "-", target_user],
                    env,
                )
            else:
                # Already target_user: cd to home directory and launch login shell
                try:
                    os.chdir(target_home)
                except Exception:
                    pass
                os.execvpe(target_shell, [target_shell, "-l"], env)
        except Exception:
            try:
                os.chdir(target_home)
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
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    password = data.get("password", "").strip()
    bssid = data.get("bssid", "").strip()

    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    safe_pwd = password.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    safe_bssid = bssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`') if bssid else ""

    if safe_pwd:
        if safe_bssid:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" password "{safe_pwd}" bssid "{safe_bssid}"')
        else:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" password "{safe_pwd}"')
    else:
        if safe_bssid:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}" bssid "{safe_bssid}"')
        else:
            cmd = _sudo(f'nmcli device wifi connect "{safe_ssid}"')

    res = await run_cmd(cmd, timeout=45)
    success = res["returncode"] == 0
    return {
        "success": success,
        "message": res["stdout"].strip() if success else (res["stderr"].strip() or res["stdout"].strip() or "接続に失敗しました"),
    }


@app.post("/api/wifi/disconnect")
async def wifi_disconnect(req: Request):
    """Disconnect currently connected Wi-Fi."""
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    device = data.get("device", "").strip()

    if ssid:
        safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        res = await run_cmd(_sudo(f'nmcli connection down id "{safe_ssid}"'), timeout=15)
        if res["returncode"] == 0:
            return {"success": True, "message": f"{ssid} から切断しました"}

    if device:
        safe_dev = device.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
        res = await run_cmd(_sudo(f'nmcli device disconnect "{safe_dev}"'), timeout=15)
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
    data = await req.json()
    ssid = data.get("ssid", "").strip()
    if not ssid:
        raise HTTPException(status_code=400, detail="SSID is required")

    safe_ssid = ssid.replace('"', '\\"').replace('$', '\\$').replace('`', '\\`')
    res = await run_cmd(_sudo(f'nmcli connection delete id "{safe_ssid}"'), timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


@app.post("/api/wifi/toggle")
async def wifi_toggle(req: Request):
    """Turn Wi-Fi radio on/off."""
    data = await req.json()
    enable = data.get("enable", True)
    cmd = _sudo("nmcli radio wifi on") if enable else _sudo("nmcli radio wifi off")
    res = await run_cmd(cmd, timeout=15)
    return {
        "success": res["returncode"] == 0,
        "message": res["stdout"].strip() or res["stderr"].strip(),
    }


# ============================================================
# 6. Disk Management
# ============================================================

async def get_sfdisk_free_info(disk_name):
    """Parse sfdisk to detect free regions and per-partition extendability."""
    disk_path = f"/dev/{disk_name}"
    result = {"total_free_bytes": 0, "partitions": []}

    res = await run_cmd(f"sfdisk -d {disk_path} 2>/dev/null", timeout=10)
    if res["returncode"] != 0:
        return result

    lines = res["stdout"].strip().split("\n")
    partitions = []
    last_lba = 0
    sector_size = 512

    for line in lines:
        line = line.strip()
        if line.startswith("last-lba:"):
            last_lba = int(line.split(":")[1].strip())
        elif line.startswith("sector-size:"):
            sector_size = int(line.split(":")[1].strip())
        elif line.startswith("/dev/"):
            start = size = None
            name = line.split(":")[0].split("/")[-1].strip()
            for field in line.split(":")[1].split(","):
                field = field.strip()
                if field.startswith("start="):
                    start = int(field.split("=")[1])
                elif field.startswith("size="):
                    size = int(field.split("=")[1])
            if start is not None and size is not None:
                partitions.append({"name": name, "start": start, "size": size, "end": start + size})

    if not partitions:
        return result

    partitions.sort(key=lambda p: p["start"])

    # GPT reserves first 34 sectors and last 33 sectors
    gpt_reserved_end = 34
    gpt_reserved_start = last_lba - 32 if last_lba > 32 else last_lba

    # Find free regions and mark extendable partitions
    free_sectors = 0
    current_pos = gpt_reserved_end

    for p in partitions:
        # Free space before this partition
        if p["start"] > current_pos:
            free_sectors += p["start"] - current_pos

        # Mark previous partition as extendable if there was a gap
        if partitions.index(p) > 0:
            prev = partitions[partitions.index(p) - 1]
            if p["start"] > prev["end"]:
                prev["extendable"] = True
                prev["max_extend_bytes"] = (p["start"] - prev["end"]) * sector_size

        current_pos = p["end"]

    # Free space after last partition
    usable_end = gpt_reserved_start
    if usable_end > current_pos:
        free_sectors += usable_end - current_pos
        partitions[-1]["extendable"] = True
        partitions[-1]["max_extend_bytes"] = (usable_end - partitions[-1]["end"]) * sector_size

    # Initialize non-extendable partitions
    for p in partitions:
        if "extendable" not in p:
            p["extendable"] = False
            p["max_extend_bytes"] = 0

    result["total_free_bytes"] = free_sectors * sector_size
    result["partitions"] = partitions
    return result


async def _get_lvm_info():
    """Gather LVM VG/LV info, keyed by PV device name."""
    result = {}
    pvs_res = await run_cmd("pvs --reportformat json -o pv_name,vg_name,pv_size,pv_free 2>/dev/null", timeout=10)
    if pvs_res["returncode"] != 0:
        return result
    try:
        pvs_data = json.loads(pvs_res["stdout"])
        for report in pvs_data.get("report", []):
            for pv in report.get("pv", []):
                pv_name = pv["pv_name"].split("/")[-1]
                result[pv_name] = {
                    "vg_name": pv["vg_name"],
                    "pv_size": pv["pv_size"],
                    "pv_free": pv["pv_free"],
                    "lvs": [],
                }
    except (json.JSONDecodeError, KeyError):
        return result

    vgs_res = await run_cmd("vgs --reportformat json -o vg_name,vg_size,vg_free 2>/dev/null", timeout=10)
    if vgs_res["returncode"] == 0:
        try:
            vgs_data = json.loads(vgs_res["stdout"])
            for report in vgs_data.get("report", []):
                for vg in report.get("vg", []):
                    for pv_info in result.values():
                        if pv_info["vg_name"] == vg["vg_name"]:
                            pv_info["vg_size"] = vg["vg_size"]
                            pv_info["vg_free"] = vg["vg_free"]
        except (json.JSONDecodeError, KeyError):
            pass

    lvs_res = await run_cmd("lvs --reportformat json -o lv_name,vg_name,lv_size,lv_path 2>/dev/null", timeout=10)
    if lvs_res["returncode"] == 0:
        try:
            lvs_data = json.loads(lvs_res["stdout"])
            for report in lvs_data.get("report", []):
                for lv in report.get("lv", []):
                    lv_path = lv.get("lv_path", "")
                    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
                    mountpoint = mp_res["stdout"].strip()
                    for pv_info in result.values():
                        if pv_info["vg_name"] == lv["vg_name"]:
                            pv_info["lvs"].append({
                                "name": lv["lv_name"],
                                "size": lv["lv_size"],
                                "path": lv_path,
                                "mountpoint": mountpoint,
                            })
        except (json.JSONDecodeError, KeyError):
            pass

    return result


@app.get("/api/disks/info")
async def disks_info():
    """Get disk and partition information using lsblk + df."""
    # lsblk: NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RM,RO,MODEL,SERIAL
    lsblk_res = await run_cmd(
        "lsblk -J -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RM,RO,MODEL,SERIAL,UUID,PARTLABEL,LABEL 2>/dev/null",
        timeout=10,
    )

    # df -h for all mounted filesystems (skip tmpfs, devtmpfs etc.)
    df_res = await run_cmd(
        "df -h -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null | tail -n +2",
        timeout=10,
    )

    # Parse lsblk JSON
    blocks = []
    try:
        blk_data = json.loads(lsblk_res["stdout"])
        blocks = blk_data.get("blockdevices", [])
    except (json.JSONDecodeError, KeyError):
        pass

    # Parse df output into a dict keyed by mountpoint
    df_info = {}
    for line in df_res["stdout"].strip().split("\n"):
        parts = line.split()
        if len(parts) >= 6:
            mount = parts[5]
            df_info[mount] = {
                "filesystem": parts[0],
                "size": parts[1],
                "used": parts[2],
                "avail": parts[3],
                "use_percent": parts[4],
                "mountpoint": mount,
            }

    def parse_size_bytes(size_str):
        """Convert human-readable size (e.g. '50G') to bytes."""
        if not size_str:
            return 0
        multipliers = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}
        size_str = str(size_str).strip()
        if size_str[-1].upper() in multipliers:
            return int(float(size_str[:-1]) * multipliers[size_str[-1].upper()])
        try:
            return int(float(size_str))
        except ValueError:
            return 0

    def parse_device(dev):
        """Recursively parse a lsblk device entry."""
        fstype = dev.get("fstype") or ""
        mountpoint = dev.get("mountpoint") or ""
        name = dev.get("name", "")
        size = dev.get("size", "")
        rm = dev.get("rm", False)
        ro = dev.get("ro", False)
        model = (dev.get("model") or "").strip()
        serial = (dev.get("serial") or "").strip()
        uuid = dev.get("uuid") or ""
        partlabel = (dev.get("partlabel") or "").strip()
        fslabel = (dev.get("label") or "").strip()
        devtype = dev.get("type", "")

        entry = {
            "name": name,
            "size": size,
            "size_bytes": parse_size_bytes(size),
            "type": devtype,
            "fstype": fstype,
            "mountpoint": mountpoint,
            "removable": rm,
            "readonly": ro,
            "model": model,
            "serial": serial,
            "uuid": uuid,
            "partlabel": partlabel,
            "label": fslabel,
        }

        # Merge df data if mounted
        if mountpoint and mountpoint in df_info:
            entry["df"] = df_info[mountpoint]

        # Recurse into children (partitions of a disk)
        children = dev.get("children", [])
        if children:
            entry["children"] = [parse_device(c) for c in children]

        return entry

    devices = [parse_device(d) for d in blocks]

    # Enrich disk entries with free space info from sfdisk
    for dev in devices:
        if dev.get("type") == "disk":
            free_info = await get_sfdisk_free_info(dev["name"])
            dev["free_bytes"] = free_info["total_free_bytes"]
            part_map = {p["name"]: p for p in free_info["partitions"]}
            for child in dev.get("children", []):
                if child["name"] in part_map:
                    child["extendable"] = part_map[child["name"]]["extendable"]
                    child["max_extend_bytes"] = part_map[child["name"]]["max_extend_bytes"]

    # Enrich LVM2_member partitions with VG/LV info
    lvm_data = await _get_lvm_info()
    def enrich_lvm(entries):
        for e in entries:
            if e.get("fstype") == "LVM2_member" and e.get("name") in lvm_data:
                e["lvm"] = lvm_data[e["name"]]
            for child in e.get("children", []):
                enrich_lvm([child])
    enrich_lvm(devices)

    return {"devices": devices}


@app.post("/api/disks/mount")
async def disks_mount(req: Request):
    """Mount a partition. Supports temporary or persistent (fstab) mount."""
    data = await req.json()
    device_name = data.get("device", "").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)
    fstype = data.get("fstype", "").strip()

    if not device_name or not mount_point:
        raise HTTPException(status_code=400, detail="device and mount_point are required")

    # Build full device path
    device_path = f"/dev/{device_name}" if not device_name.startswith("/dev/") else device_name

    # Validate device exists
    check = await run_cmd(f"test -b {device_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"デバイス {device_path} が見つかりません"}

    # Create mount point if it doesn't exist
    await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)

    if persistent:
        # Get UUID for fstab
        blkid = await run_cmd(f"blkid -s UUID -o value {device_path}", timeout=5)
        uuid = blkid["stdout"].strip()
        if not uuid:
            return {"success": False, "message": "UUIDを取得できませんでした"}

        # Determine fstype for fstab if not provided
        if not fstype:
            blkid_type = await run_cmd(f"blkid -s TYPE -o value {device_path}", timeout=5)
            fstype = blkid_type["stdout"].strip()

        if not fstype:
            return {"success": False, "message": "ファイルシステムタイプを取得できませんでした"}

        # Check if already in fstab
        fstab_check = await run_cmd(f"grep -q '{uuid}' /etc/fstab", timeout=5)
        if fstab_check["returncode"] == 0:
            return {"success": False, "message": "このデバイスは既に/etc/fstabに登録されています"}

        # Add to fstab (options: defaults,nofail for safety)
        fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
        add_fstab = await run_cmd(
            _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
            timeout=10,
        )
        if add_fstab["returncode"] != 0:
            return {"success": False, "message": f"/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}"}

        # Now mount it
        mount_res = await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": False, "message": f"マウントに失敗しました: {mount_res['stderr']}"}

        return {"success": True, "message": f"永続マウントしました: {device_path} → {mount_point}"}

    else:
        # Temporary mount
        mount_res = await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": False, "message": f"マウントに失敗しました: {mount_res['stderr']}"}
        return {"success": True, "message": f"一時マウントしました: {device_path} → {mount_point}"}


@app.post("/api/disks/unmount")
async def disks_unmount(req: Request):
    """Unmount a partition."""
    data = await req.json()
    device_name = data.get("device", "").strip()
    mount_point = data.get("mount_point", "").strip()

    if not device_name and not mount_point:
        raise HTTPException(status_code=400, detail="device or mount_point is required")

    target = mount_point if mount_point else f"/dev/{device_name}"
    device_path = f"/dev/{device_name}" if not device_name.startswith("/dev/") else device_name

    # Unmount
    res = await run_cmd(_sudo(f"umount {target}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"アンマウントに失敗しました: {res['stderr']}"}

    # If there was a fstab entry, offer info (don't auto-remove for safety)
    fstab_check = await run_cmd(f"grep -n '{device_path}\\|{mount_point}' /etc/fstab 2>/dev/null", timeout=5)
    fstab_entry = fstab_check["stdout"].strip() if fstab_check["returncode"] == 0 else ""

    msg = f"アンマウントしました: {target}"
    if fstab_entry:
        msg += "\n注意: /etc/fstabにエントリが残っています。永続マウント設定を解除する場合はターミナルで手動で削除してください。"

    return {"success": True, "message": msg, "fstab_entry": fstab_entry}


@app.post("/api/disks/partition/create")
async def disks_partition_create(req: Request):
    """Create a new partition on a disk with optional filesystem and mount."""
    data = await req.json()
    disk_name = data.get("disk", "").strip()
    size_sectors = data.get("size_sectors", 0)
    fstype = data.get("fstype", "ext4").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)

    if not disk_name or size_sectors <= 0:
        raise HTTPException(status_code=400, detail="disk and size_sectors are required")

    disk_path = f"/dev/{disk_name}"

    # Verify it's a disk device
    type_check = await run_cmd(f"lsblk -dno TYPE {disk_path} 2>/dev/null", timeout=5)
    if type_check["stdout"].strip() != "disk":
        return {"success": False, "message": f"{disk_path} はディスクデバイスではありません"}

    # Create partition using sfdisk
    type_uuid = "0FC63DAF-8483-4772-8E79-3D69D8477DE4"  # Linux filesystem
    if fstype == "swap":
        type_uuid = "0657FD6D-A4AB-43C4-84B5-1560EF63A218"  # Linux swap
    elif fstype in ("vfat", "fat32", "fat16"):
        type_uuid = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B"  # EFI System

    sfdisk_input = f"type={type_uuid}, size={size_sectors}"
    res = await run_cmd(
        _sudo(f"echo '{sfdisk_input}' | sfdisk --append --no-reread {disk_path}"),
        timeout=15,
    )
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション作成に失敗しました: {res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)
    await asyncio.sleep(1)

    # Find the newly created partition
    lsblk_res = await run_cmd(f"lsblk -Jno NAME,SIZE,TYPE {disk_path} 2>/dev/null", timeout=10)
    new_part_name = None
    try:
        blk = json.loads(lsblk_res["stdout"])
        children = blk.get("blockdevices", [])
        if children:
            parts = children[0].get("children", [])
            if parts:
                new_part_name = parts[-1]["name"]
    except (json.JSONDecodeError, KeyError):
        pass

    if not new_part_name:
        return {"success": True, "message": "パーティションを作成しました（デバイス名の取得に失敗しました）"}

    new_part_path = f"/dev/{new_part_name}"

    # Format filesystem (skip for swap)
    if fstype == "swap":
        mkfs_res = await run_cmd(_sudo(f"mkswap {new_part_path}"), timeout=30)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"swapの作成に失敗しました: {mkfs_res['stderr']}"}
        return {"success": True, "message": f"パーティション {new_part_name} を作成し、swapとして初期化しました", "device": new_part_name}
    else:
        mkfs_cmd = f"mkfs.{fstype} {new_part_path}"
        mkfs_res = await run_cmd(_sudo(mkfs_cmd), timeout=60)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム作成に失敗しました: {mkfs_res['stderr']}"}

    # Mount if requested
    if mount_point:
        await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)
        mount_res = await run_cmd(_sudo(f"mount {new_part_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": True, "message": f"パーティション {new_part_name} を作成しましたが、マウントに失敗しました: {mount_res['stderr']}", "device": new_part_name}

        if persistent:
            blkid = await run_cmd(f"blkid -s UUID -o value {new_part_path}", timeout=5)
            uuid = blkid["stdout"].strip()
            if uuid:
                fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
                add_fstab = await run_cmd(
                    _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
                    timeout=10,
                )
                if add_fstab["returncode"] != 0:
                    return {"success": True, "message": f"パーティション {new_part_name} を作成しましたが、/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}", "device": new_part_name}

    msg = f"パーティション {new_part_name} を作成しました ({fstype})"
    if mount_point:
        msg += f" → {mount_point}"
    if persistent and mount_point:
        msg += " (永続マウント)"
    return {"success": True, "message": msg, "device": new_part_name}


@app.post("/api/disks/partition/extend")
async def disks_partition_extend(req: Request):
    """Extend a partition to use available free space."""
    data = await req.json()
    device_name = data.get("device", "").strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="device is required")

    device_path = f"/dev/{device_name}"

    # Verify it's a partition
    type_check = await run_cmd(f"lsblk -dno TYPE {device_path} 2>/dev/null", timeout=5)
    dev_type = type_check["stdout"].strip()
    if dev_type not in ("part", "lvm"):
        return {"success": False, "message": f"{device_path} はパーティションではありません"}

    # Find parent disk and get free info
    parent_res = await run_cmd(f"lsblk -dno PKNAME {device_path} 2>/dev/null", timeout=5)
    parent_disk = parent_res["stdout"].strip()
    if not parent_disk:
        return {"success": False, "message": "親ディスクが見つかりません"}

    free_info = await get_sfdisk_free_info(parent_disk)
    part_info = None
    for p in free_info["partitions"]:
        if p["name"] == device_name:
            part_info = p
            break

    if not part_info or not part_info.get("extendable"):
        return {"success": False, "message": "このパーティションは拡張できません（隣接する空き領域がありません）"}

    max_bytes = part_info["max_extend_bytes"]
    sector_size = 512
    add_sectors = max_bytes // sector_size
    new_size_sectors = part_info["size"] + add_sectors

    # Get partition number from name (e.g., vda3 -> 3)
    part_num = ""
    for ch in reversed(device_name):
        if ch.isdigit():
            part_num = ch + part_num
        else:
            break

    if not part_num:
        return {"success": False, "message": "パーティション番号を取得できませんでした"}

    disk_path = f"/dev/{parent_disk}"

    # Check if the partition is mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {device_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()

    # Detect filesystem type
    fs_res = await run_cmd(f"blkid -s TYPE -o value {device_path} 2>/dev/null", timeout=5)
    fs_type = fs_res["stdout"].strip()

    # Unmount if mounted (resize2fs/xfs_growfs can work online but partition resize needs unmount for safety)
    needs_remount = False
    if mountpoint:
        unmount_res = await run_cmd(_sudo(f"umount {device_path}"), timeout=15)
        if unmount_res["returncode"] != 0:
            return {"success": False, "message": f"アンマウントに失敗しました: {unmount_res['stderr']}"}
        needs_remount = True

    # Resize partition using sfdisk
    sfdisk_input = f"{part_num}: size={new_size_sectors}"
    resize_res = await run_cmd(
        _sudo(f"echo '{sfdisk_input}' | sfdisk --no-reread -N {part_num} {disk_path}"),
        timeout=15,
    )
    if resize_res["returncode"] != 0:
        # Try to remount if we unmounted
        if needs_remount and mountpoint:
            await run_cmd(_sudo(f"mount {device_path} {mount_point}"), timeout=15)
        return {"success": False, "message": f"パーティション拡張に失敗しました: {resize_res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)
    await asyncio.sleep(1)

    # Resize filesystem
    if fs_type == "ext4" or fs_type == "ext3" or fs_type == "ext2":
        fs_res = await run_cmd(_sudo(f"resize2fs {device_path}"), timeout=30)
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res['stderr']}"}
    elif fs_type == "xfs":
        # XFS needs a mount point for growfs
        if mountpoint:
            fs_res = await run_cmd(_sudo(f"xfs_growfs {mountpoint}"), timeout=30)
        else:
            fs_res = {"returncode": 1, "stderr": "XFSはマウントされていない状態では拡張できません"}
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res.get('stderr', 'unknown error')}"}
    elif fs_type == "btrfs":
        if mountpoint:
            fs_res = await run_cmd(_sudo(f"btrfs filesystem resize max {mountpoint}"), timeout=30)
        else:
            fs_res = {"returncode": 1, "stderr": "Btrfsはマウントされていない状態では拡張できません"}
        if fs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム拡張に失敗しました: {fs_res.get('stderr', 'unknown error')}"}

    # Remount if needed
    if needs_remount and mountpoint:
        await run_cmd(_sudo(f"mount {device_path} {mountpoint}"), timeout=15)

    msg = f"パーティション {device_name} を拡張しました (+{_format_bytes(max_bytes)})"
    if needs_remount and mountpoint:
        msg += f" (マウント済み: {mountpoint})"
    return {"success": True, "message": msg}


def _format_bytes(b):
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if b < 1024:
            return f"{b:.1f}{unit}"
        b /= 1024
    return f"{b:.1f}PB"


@app.post("/api/disks/lv/create")
async def disks_lv_create(req: Request):
    """Create a new logical volume in a VG, format and optionally mount."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()
    size = data.get("size", "").strip()
    fstype = data.get("fstype", "ext4").strip()
    mount_point = data.get("mount_point", "").strip()
    persistent = data.get("persistent", False)

    if not vg_name or not lv_name or not size:
        raise HTTPException(status_code=400, detail="vg_name, lv_name, and size are required")

    # Create LV
    lv_path = f"/dev/{vg_name}/{lv_name}"
    res = await run_cmd(_sudo(f"lvcreate -L {size} -n {lv_name} --yes {vg_name}"), timeout=30)
    if res["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム作成に失敗しました: {res['stderr']}"}

    # Format
    if fstype == "swap":
        mkfs_res = await run_cmd(_sudo(f"mkswap {lv_path}"), timeout=30)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"swapの初期化に失敗しました: {mkfs_res['stderr']}"}
        swapon_res = await run_cmd(_sudo(f"swapon {lv_path}"), timeout=10)
        msg = f"LV {lv_name} を作成し、swapとして有効にしました"
        return {"success": True, "message": msg, "device": lv_name}
    else:
        mkfs_res = await run_cmd(_sudo(f"mkfs.{fstype} {lv_path}"), timeout=60)
        if mkfs_res["returncode"] != 0:
            return {"success": False, "message": f"ファイルシステム作成に失敗しました: {mkfs_res['stderr']}"}

    # Mount if requested
    if mount_point:
        await run_cmd(_sudo(f"mkdir -p {mount_point}"), timeout=5)
        mount_res = await run_cmd(_sudo(f"mount {lv_path} {mount_point}"), timeout=15)
        if mount_res["returncode"] != 0:
            return {"success": True, "message": f"LV {lv_name} を作成しましたが、マウントに失敗しました: {mount_res['stderr']}", "device": lv_name}

        if persistent:
            blkid = await run_cmd(f"blkid -s UUID -o value {lv_path}", timeout=5)
            uuid = blkid["stdout"].strip()
            if uuid:
                fstab_line = f"UUID={uuid}\t{mount_point}\t{fstype}\tdefaults,nofail\t0\t2"
                add_fstab = await run_cmd(
                    _sudo(f"echo '{fstab_line}' >> /etc/fstab"),
                    timeout=10,
                )
                if add_fstab["returncode"] != 0:
                    return {"success": True, "message": f"LV {lv_name} を作成しましたが、/etc/fstabへの追加に失敗しました: {add_fstab['stderr']}", "device": lv_name}

    msg = f"LV {lv_name} を作成しました ({fstype}, {size})"
    if mount_point:
        msg += f" → {mount_point}"
    if persistent and mount_point:
        msg += " (永続マウント)"
    return {"success": True, "message": msg, "device": lv_name}


@app.post("/api/disks/lv/resize")
async def disks_lv_resize(req: Request):
    """Resize a logical volume and its filesystem."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()
    size = data.get("size", "").strip()  # e.g., "30G" or "+10G"

    if not vg_name or not lv_name or not size:
        raise HTTPException(status_code=400, detail="vg_name, lv_name, and size are required")

    lv_path = f"/dev/{vg_name}/{lv_name}"

    # Check if LV exists
    check = await run_cmd(f"test -b {lv_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム {lv_path} が見つかりません"}

    # Detect filesystem type
    fs_res = await run_cmd(f"blkid -s TYPE -o value {lv_path} 2>/dev/null", timeout=5)
    fs_type = fs_res["stdout"].strip()

    # Get mount point
    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()

    # Resize LV
    resize_cmd = f"lvresize -r -L {size} {lv_path}"
    res = await run_cmd(_sudo(resize_cmd), timeout=30)
    if res["returncode"] != 0:
        return {"success": False, "message": f"LVリサイズに失敗しました: {res['stderr']}"}

    msg = f"LV {lv_name} を {size} にリサイズしました"
    if mountpoint:
        msg += f" (マウント済み: {mountpoint})"
    return {"success": True, "message": msg}


@app.post("/api/disks/partition/delete")
async def disks_partition_delete(req: Request):
    """Delete a partition from a disk."""
    data = await req.json()
    device_name = data.get("device", "").strip()

    if not device_name:
        raise HTTPException(status_code=400, detail="device is required")

    device_path = f"/dev/{device_name}"

    # Verify it's a partition
    type_check = await run_cmd(f"lsblk -dno TYPE {device_path} 2>/dev/null", timeout=5)
    dev_type = type_check["stdout"].strip()
    if dev_type not in ("part", "lvm"):
        return {"success": False, "message": f"{device_path} はパーティションではありません"}

    # Check if mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {device_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()
    if mountpoint:
        return {"success": False, "message": f"マウント中のパーティションは削除できません（{mountpoint}）。\n先にアンマウントしてください。"}

    # Get parent disk
    parent_res = await run_cmd(f"lsblk -dno PKNAME {device_path} 2>/dev/null", timeout=5)
    parent_disk = parent_res["stdout"].strip()
    if not parent_disk:
        return {"success": False, "message": "親ディスクが見つかりません"}

    # Check if it's an LVM PV - refuse deletion if so
    pv_check = await run_cmd(f"pvs --noheadings -o vg_name {device_path} 2>/dev/null", timeout=5)
    if pv_check["returncode"] == 0 and pv_check["stdout"].strip():
        return {"success": False, "message": f"このパーティションはLVM物理ボリュームとして使用中です（VG: {pv_check['stdout'].strip()}）。LVを先に削除してください。"}

    # Get partition number
    part_num = ""
    for ch in reversed(device_name):
        if ch.isdigit():
            part_num = ch + part_num
        else:
            break
    if not part_num:
        return {"success": False, "message": "パーティション番号を取得できませんでした"}

    disk_path = f"/dev/{parent_disk}"

    # Delete partition using sfdisk
    res = await run_cmd(_sudo(f"sfdisk --delete {disk_path} {part_num}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション削除に失敗しました: {res['stderr']}"}

    # Re-read partition table
    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)

    return {"success": True, "message": f"パーティション {device_name} を削除しました"}


@app.post("/api/disks/disk/wipe")
async def disks_disk_wipe(req: Request):
    """Delete all partitions from a disk."""
    data = await req.json()
    disk_name = data.get("device", "").strip()

    if not disk_name:
        raise HTTPException(status_code=400, detail="device is required")

    disk_path = f"/dev/{disk_name}"

    # Verify it's a disk
    type_check = await run_cmd(f"lsblk -dno TYPE {disk_path} 2>/dev/null", timeout=5)
    if type_check["stdout"].strip() != "disk":
        return {"success": False, "message": f"{disk_path} はディスクデバイスではありません"}

    # Check if any partition is mounted
    mp_check = await run_cmd(f"findmnt -n -o TARGET,SOURCE 2>/dev/null | grep '{disk_path}'", timeout=5)
    if mp_check["stdout"].strip():
        return {"success": False, "message": "マウント中のパーティションが含まれています。先にすべてアンマウントしてください。"}

    # Check if any partition is an LVM PV
    pv_check = await run_cmd(f"pvs --noheadings -o pv_name,vg_name 2>/dev/null | grep '{disk_path}'", timeout=5)
    if pv_check["stdout"].strip():
        return {"success": False, "message": f"LVM物理ボリュームが含まれています。先にVGを削除してください。\n{pv_check['stdout'].strip()}"}

    # Delete all partitions
    res = await run_cmd(_sudo(f"sfdisk --delete {disk_path}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"パーティション削除に失敗しました: {res['stderr']}"}

    await run_cmd(_sudo(f"partprobe {disk_path}"), timeout=10)

    return {"success": True, "message": f"ディスク {disk_name} の全パーティションを削除しました"}


@app.post("/api/disks/lv/delete")
async def disks_lv_delete(req: Request):
    """Delete a logical volume."""
    data = await req.json()
    vg_name = data.get("vg_name", "").strip()
    lv_name = data.get("lv_name", "").strip()

    if not vg_name or not lv_name:
        raise HTTPException(status_code=400, detail="vg_name and lv_name are required")

    lv_path = f"/dev/{vg_name}/{lv_name}"

    # Check if LV exists
    check = await run_cmd(f"test -b {lv_path}", timeout=5)
    if check["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム {lv_path} が見つかりません"}

    # Check if mounted
    mp_res = await run_cmd(f"findmnt -n -o TARGET {lv_path} 2>/dev/null", timeout=5)
    mountpoint = mp_res["stdout"].strip()
    if mountpoint:
        return {"success": False, "message": f"マウント中の論理ボリュームは削除できません（{mountpoint}）。\n先にアンマウントしてください。"}

    # Check if it's swap
    swap_res = await run_cmd(f"swapon --show=NAME --noheadings 2>/dev/null | grep -q '{lv_path}'", timeout=5)
    if swap_res["returncode"] == 0:
        await run_cmd(_sudo(f"swapoff {lv_path}"), timeout=15)

    # Delete LV
    res = await run_cmd(_sudo(f"lvremove -f {lv_path}"), timeout=15)
    if res["returncode"] != 0:
        return {"success": False, "message": f"論理ボリューム削除に失敗しました: {res['stderr']}"}

    return {"success": True, "message": f"論理ボリューム {lv_name} を削除しました"}


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


@app.post("/api/servui/restart")
async def restart_servui():
    """Restart serv-UI service."""
    async def do_restart():
        await asyncio.sleep(0.5)
        await run_cmd(_sudo("systemctl restart servui"), timeout=15)
    asyncio.create_task(do_restart())
    return {"success": True, "stdout": "Restarting...", "errors": ""}


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
