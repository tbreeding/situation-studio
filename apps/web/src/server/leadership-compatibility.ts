import {
  LeadershipCapabilityError,
  runtimeCapabilitiesFromHealth,
} from "@situation-studio/leadership-bridge";
import { environment } from "@/server/environment";

export async function requireCompatibleLeadershipRuntime() {
  const capabilitiesUrl = environment().LEADERSHIP_RUNTIME_CAPABILITIES_URL;
  if (!capabilitiesUrl)
    throw new LeadershipCapabilityError(
      "Leadership runtime compatibility cannot be verified.",
      "RUNTIME_CAPABILITY_UNAVAILABLE",
      true,
    );
  return runtimeCapabilitiesFromHealth(capabilitiesUrl);
}
