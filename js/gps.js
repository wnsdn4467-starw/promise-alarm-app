/* ==========================================================================
   GPS Geofencing & Location Engine
   ========================================================================== */

const POPULAR_LOCATIONS = {
  gangnam: { name: "강남역 10번 출구", lat: 37.4979, lng: 127.0276 },
  hongdae: { name: "홍대입구역 9번 출구", lat: 37.5568, lng: 126.9238 },
  yeouido: { name: "여의도 한강공원", lat: 37.5284, lng: 126.9341 },
  seongsu: { name: "성수역 4번 출구", lat: 37.5445, lng: 127.0560 }
};

class GPSEngine {
  constructor() {
    this.simulatedLocation = null; // null means use real browser GPS
  }

  // Haversine formula to compute distance in meters between two lat/lng points
  calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(R * c); // Meters
  }

  // Get current user location (Real or Simulated)
  async getCurrentLocation(targetLat, targetLng) {
    if (this.simulatedLocation) {
      return this.simulatedLocation;
    }

    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        // Fallback simulation if browser doesn't support
        resolve({ lat: targetLat + 0.0001, lng: targetLng + 0.0001, isReal: false });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            isReal: true
          });
        },
        (error) => {
          console.warn("Geolocation permission error or unavailable, falling back to simulated nearby location", error);
          // Fallback if user denies permission
          resolve({
            lat: targetLat + 0.0002,
            lng: targetLng + 0.0002,
            isReal: false
          });
        },
        { enableHighAccuracy: true, timeout: 5000 }
      );
    });
  }

  // Simulate specific distance scenarios for interactive demo
  setSimulationMode(targetLat, targetLng, mode) {
    // 0.0001 degree is approx 11 meters
    if (mode === 'arrived') {
      // 20 meters away (Inside geofence)
      this.simulatedLocation = {
        lat: targetLat + 0.00015,
        lng: targetLng + 0.00015,
        isSimulated: true,
        modeName: "도착 완료 (반경 20m 이내)"
      };
    } else if (mode === 'near') {
      // 150 meters away (Just outside typical 100m geofence)
      this.simulatedLocation = {
        lat: targetLat + 0.0012,
        lng: targetLng + 0.0012,
        isSimulated: true,
        modeName: "근처 올리브영 (150m 거리)"
      };
    } else if (mode === 'late') {
      // 2.5km away (Far / Late)
      this.simulatedLocation = {
        lat: targetLat + 0.022,
        lng: targetLng + 0.022,
        isSimulated: true,
        modeName: "지하철 이동 중 (2.5km 거리)"
      };
    }
  }

  clearSimulationMode() {
    this.simulatedLocation = null;
  }
}

window.gpsEngine = new GPSEngine();
