#!/bin/bash
# ============================================================
# bing-wallpaper: 1日1回 Bing の今日の画像を取得し、
#                 GNOME のデスクトップ壁紙に設定する (Snap 不要)
# ------------------------------------------------------------
# /etc/cron.d/bing-wallpaper から root として毎日実行される。
# 対象ユーザーは引数で指定できるが、省略時は UID>=1000 の
# /home 配下ユーザーを自動検出する。
# ============================================================
set -u

RUN_USER="${1:-}"
if [ -z "$RUN_USER" ]; then
    RUN_USER="$(getent passwd | awk -F: '$3 >= 1000 && $3 < 65540 && $6 ~ /^\/home\// {print $1; exit}')"
fi
[ -n "$RUN_USER" ] || { echo "error: 対象ユーザーを特定できません"; exit 1; }

RUN_UID="$(id -u "$RUN_USER")" || exit 1
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || RUN_HOME="/home/$RUN_USER"

IMG_DIR="$RUN_HOME/.cache/bing-wallpaper"
IMG_FILE="$IMG_DIR/bing.jpg"
METADATA_FILE="$IMG_DIR/info.txt"
TMP_FILE="$IMG_DIR/bing.jpg.new"

mkdir -p "$IMG_DIR"

# --- Bing API で今日の画像情報を取得 ---
API='https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=ja-JP'
JSON="$(curl -fsSL --max-time 30 "$API" 2>/dev/null)" || { echo "error: Bing API へのアクセスに失敗しました"; exit 1; }
[ -n "$JSON" ] || { echo "error: Bing API の応答が空です"; exit 1; }

URL="$(printf '%s' "$JSON" | sed -n 's/.*"url" *: *"\([^"]*\)".*/\1/p' | head -1)"
URLBASE="$(printf '%s' "$JSON" | sed -n 's/.*"urlbase" *: *"\([^"]*\)".*/\1/p' | head -1)"
TITLE="$(printf '%s' "$JSON" | sed -n 's/.*"title" *: *"\([^"]*\)".*/\1/p' | head -1)"
COPYRIGHT="$(printf '%s' "$JSON" | sed -n 's/.*"copyright" *: *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$URL" ] || { echo "error: 画像 URL を取得できませんでした"; exit 1; }

# --- 4K(UHD) 版を優先、失敗時は通常版にフォールバック ---
UHD_URL=""
[ -n "$URLBASE" ] && UHD_URL="https://www.bing.com${URLBASE}_UHD.jpg"

download_ok=0
if [ -n "$URLBASE" ] && curl -fsSL --max-time 120 -o "$TMP_FILE" "$UHD_URL" 2>/dev/null; then
    download_ok=1
fi
if [ "$download_ok" = 0 ]; then
    curl -fsSL --max-time 120 -o "$TMP_FILE" "https://www.bing.com${URL}" || {
        echo "error: 画像のダウンロードに失敗しました"; rm -f "$TMP_FILE"; exit 1;
    }
fi

file "$TMP_FILE" 2>/dev/null | grep -qi 'image' || { echo "error: 取得ファイルが画像ではありません"; rm -f "$TMP_FILE"; exit 1; }

mv -f "$TMP_FILE" "$IMG_FILE"
{
    printf 'date: %s\n' "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M')"
    printf 'title: %s\n' "$TITLE"
    printf 'copyright: %s\n' "$COPYRIGHT"
} > "$METADATA_FILE"
chown -R "$RUN_USER:$(id -g "$RUN_USER")" "$IMG_DIR" || true

# --- GNOME の壁紙に設定 (ユーザーのセッションバス経由) ---
RUN_USER_ENV=(
    env
    "XDG_RUNTIME_DIR=/run/user/$RUN_UID"
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$RUN_UID/bus"
)
if [ -d "/run/user/$RUN_UID" ]; then
    sudo -u "$RUN_USER" "${RUN_USER_ENV[@]}" gsettings set org.gnome.desktop.background picture-uri "file://$IMG_FILE" 2>/dev/null
    sudo -u "$RUN_USER" "${RUN_USER_ENV[@]}" gsettings set org.gnome.desktop.background picture-uri-dark "file://$IMG_FILE" 2>/dev/null
    echo "ok: 壁紙を更新しました (ユーザー: $RUN_USER / 画像: $IMG_FILE)"
else
    echo "warn: 画像は保存されましたが、ユーザーセッションがないため壁紙は更新されませんでした (/run/user/$RUN_UID 無し)"
fi
echo "title: $TITLE"
echo "copyright: $COPYRIGHT"
