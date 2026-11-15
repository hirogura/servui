#!/bin/bash
# ============================================================
# bing-wallpaper: Bing の今日の画像を取得し、
#                 GNOME のデスクトップ壁紙に設定する (Snap 不要)
# ------------------------------------------------------------
# /etc/cron.d/bing-wallpaper から root として
#   毎日 07:30 と PC 起動時 (@reboot) に実行される。
# その日の画像を取得済みの場合はダウンロードをスキップし、
# 壁紙の再適用だけを行う (1日1回取得を保証)。
#
# 引数:
#   --force, -f  本日分を取得済みでも強制的に再取得する
#   <username>   対象ユーザー (省略時は UID>=1000 の /home 配下ユーザー)
# ============================================================
set -u

RUN_USER=""
FORCE=0
for arg in "$@"; do
    case "$arg" in
        --force|-f) FORCE=1 ;;
        *) RUN_USER="$arg" ;;
    esac
done

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

# 起動直後はユーザーセッション (D-Bus) がまだ無いことがあるため、
# 壁紙設定時はこの秒数までセッションの立ち上がりを待つ。
SESSION_WAIT="${BING_WP_SESSION_WAIT:-180}"

today_jst() { TZ=Asia/Tokyo date '+%Y-%m-%d'; }

# --- GNOME の壁紙に設定 (ユーザーのセッションバス経由) ---
apply_wallpaper() {
    if [ ! -d "/run/user/$RUN_UID" ] && [ "$SESSION_WAIT" -gt 0 ] 2>/dev/null; then
        waited=0
        while [ "$waited" -lt "$SESSION_WAIT" ]; do
            sleep 2
            waited=$((waited + 2))
            [ -d "/run/user/$RUN_UID" ] && break
        done
    fi
    if [ -d "/run/user/$RUN_UID" ]; then
        local env_args=(
            env
            "XDG_RUNTIME_DIR=/run/user/$RUN_UID"
            "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$RUN_UID/bus"
        )
        sudo -u "$RUN_USER" "${env_args[@]}" gsettings set org.gnome.desktop.background picture-uri "file://$IMG_FILE" 2>/dev/null
        sudo -u "$RUN_USER" "${env_args[@]}" gsettings set org.gnome.desktop.background picture-uri-dark "file://$IMG_FILE" 2>/dev/null
        echo "ok: 壁紙を更新しました (ユーザー: $RUN_USER / 画像: $IMG_FILE)"
    else
        echo "warn: 画像は保存されましたが、ユーザーセッションがないため壁紙は更新されませんでした (/run/user/$RUN_UID 無し)"
    fi
}

mkdir -p "$IMG_DIR"

# --- 本日分を取得済みならダウンロードをスキップ ---
LAST_DATE=""
if [ -f "$METADATA_FILE" ]; then
    LAST_DATE="$(sed -n 's/^date: *\([0-9][0-9-]*\).*/\1/p' "$METADATA_FILE" | head -1)"
fi
if [ "$FORCE" -ne 1 ] && [ -s "$IMG_FILE" ] && [ "$LAST_DATE" = "$(today_jst)" ]; then
    echo "skip: 本日分 ($LAST_DATE) は取得済みのためダウンロードを省略します"
    apply_wallpaper
    exit 0
fi

# --- Bing API で今日の画像情報を取得 (起動直後のネットワーク待ちも考慮して再試行) ---
API='https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=ja-JP'
JSON=""
for attempt in $(seq 1 12); do
    JSON="$(curl -fsSL --max-time 30 "$API" 2>/dev/null)" && [ -n "$JSON" ] && break
    JSON=""
    [ "$attempt" -lt 12 ] && sleep 5
done
[ -n "$JSON" ] || { echo "error: Bing API へのアクセスに失敗しました"; exit 1; }

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

apply_wallpaper
echo "title: $TITLE"
echo "copyright: $COPYRIGHT"
