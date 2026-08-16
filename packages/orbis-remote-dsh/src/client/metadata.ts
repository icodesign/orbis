import { ORBIS_TRANSPORT_PROTOCOL_VERSION } from "@orbisapp/transport/protocol-version";

import packageManifest from "../../package.json";

export const ORBIS_PLUGIN_VERSION = packageManifest.version;
export const ORBIS_PROTOCOL_VERSION = ORBIS_TRANSPORT_PROTOCOL_VERSION;
