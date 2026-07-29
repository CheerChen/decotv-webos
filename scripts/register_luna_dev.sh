#!/bin/sh
# Register the opkg/hot-pushed DecoTV app + JS service on the Luna bus.
#
# Development/rooted-TV helper only. A normal ares-install generates these
# files automatically; release instructions must not require this script.
set -eu

APP_ID="com.cheerchen.decotv"
SERVICE_ID="${APP_ID}.service"
VERSION="0.4.2"
LUNA_DIR="/var/luna-service2-dev"
SERVICE_DIR="/media/developer/apps/usr/palm/services/${SERVICE_ID}"

test -f "${SERVICE_DIR}/services.json"
mkdir -p \
  "${LUNA_DIR}/roles.d" \
  "${LUNA_DIR}/client-permissions.d" \
  "${LUNA_DIR}/services.d" \
  "${LUNA_DIR}/api-permissions.d" \
  "${LUNA_DIR}/manifests.d"

cat > "${LUNA_DIR}/roles.d/${APP_ID}.app.json" <<EOF
{
  "appId": "${APP_ID}",
  "type": "regular",
  "allowedNames": ["${APP_ID}-*"],
  "trustLevel": "",
  "permissions": [
    { "service": "${APP_ID}-*", "outbound": ["${SERVICE_ID}"] }
  ]
}
EOF

cat > "${LUNA_DIR}/roles.d/${SERVICE_ID}.service.json" <<EOF
{
  "appId": "${SERVICE_ID}",
  "type": "regular",
  "allowedNames": ["${SERVICE_ID}"],
  "trustLevel": "",
  "permissions": [
    { "service": "${SERVICE_ID}", "outbound": [] }
  ]
}
EOF

printf '{"%s-*":["%s.group"]}\n' "${APP_ID}" "${SERVICE_ID}" \
  > "${LUNA_DIR}/client-permissions.d/${APP_ID}.app.json"
printf '{"%s*":[]}\n' "${SERVICE_ID}" \
  > "${LUNA_DIR}/client-permissions.d/${SERVICE_ID}.service.json"

cat > "${LUNA_DIR}/services.d/${SERVICE_ID}.service" <<EOF
[D-BUS Service]
Name=${SERVICE_ID}
Exec=/usr/bin/run-js-service -n ${SERVICE_DIR}
Type=dynamic
EOF

printf '{"%s.group":["%s/*"]}\n' \
  "${SERVICE_ID}" "${SERVICE_ID}" \
  > "${LUNA_DIR}/api-permissions.d/${SERVICE_ID}.api.json"

cat > "${LUNA_DIR}/manifests.d/${APP_ID}.json" <<EOF
{
  "version": "${VERSION}",
  "id": "${APP_ID}",
  "serviceFiles": ["${LUNA_DIR}/services.d/${SERVICE_ID}.service"],
  "apiPermissionFiles": ["${LUNA_DIR}/api-permissions.d/${SERVICE_ID}.api.json"],
  "roleFiles": [
    "${LUNA_DIR}/roles.d/${SERVICE_ID}.service.json",
    "${LUNA_DIR}/roles.d/${APP_ID}.app.json"
  ],
  "clientPermissionFiles": [
    "${LUNA_DIR}/client-permissions.d/${SERVICE_ID}.service.json",
    "${LUNA_DIR}/client-permissions.d/${APP_ID}.app.json"
  ]
}
EOF

ls-control scan-services
echo "registered ${APP_ID} + ${SERVICE_ID}; cold-restart the app before testing"
