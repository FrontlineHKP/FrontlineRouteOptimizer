import React, { useState, useEffect } from "react";
import { GoogleMap, Marker, DirectionsRenderer, useJsApiLoader } from "@react-google-maps/api";

export default function App() {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "");
  const [depot, setDepot] = useState({ address: "", lat: null, lng: null });
  const [clients, setClients] = useState([]);
  const [teams, setTeams] = useState(1);
  const [days, setDays] = useState(5);
  const [startDate, setStartDate] = useState("");
  const [routes, setRoutes] = useState({});
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [dirResponse, setDirResponse] = useState(null);

  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: apiKey || "",
    libraries: apiKey ? ["places"] : []
  });

  // Simple geocoding helper
  function geocodeAddress(address, cb) {
    if (!isLoaded || !apiKey || !window?.google?.maps) { cb(null); return; }
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ address }, (results, status) => {
      if (status === "OK" && results[0]) {
        cb({ lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() });
      } else {
        cb(null);
      }
    });
  }

  // Generate dummy schedule (for demo; replace with real optimizer)
  function generateSchedule() {
    if (!depot.lat || clients.length === 0) {
      alert("Please geocode depot and clients first");
      return;
    }
    const result = {};
    for (let d = 0; d < days; d++) {
      result[d] = [];
      for (let t = 0; t < teams; t++) {
        const chunk = clients.filter((_, i) => (i + d + t) % teams === t);
        result[d].push(chunk);
      }
    }
    setRoutes(result);
    setSelectedRoute({ day: 0, team: 0, stops: result[0][0] });
  }

  // Build directions line for selected route
  useEffect(() => {
    if (!selectedRoute || !isLoaded) { setDirResponse(null); return; }
    if (!apiKey || !window?.google?.maps) { setDirResponse(null); return; }
    if (!selectedRoute.stops.length) { setDirResponse(null); return; }

    const directionsService = new window.google.maps.DirectionsService();
    directionsService.route(
      {
        origin: { lat: depot.lat, lng: depot.lng },
        destination: { lat: depot.lat, lng: depot.lng },
        waypoints: selectedRoute.stops.map(c => ({ location: { lat: c.lat, lng: c.lng } })),
        travelMode: window.google.maps.TravelMode.DRIVING
      },
      (result, status) => {
        if (status === "OK") {
          setDirResponse(result);
        } else {
          setDirResponse(null);
        }
      }
    );
  }, [selectedRoute, depot, isLoaded, apiKey]);

  if (loadError) {
    return <div style={{ padding: 24 }}>Google Maps failed to load. Check your API key and restrictions.</div>;
  }

  return (
    <div className="flex h-screen">
      {/* Left panel */}
      <div className="w-1/3 p-4 overflow-y-scroll bg-gray-100">
        <h1 className="text-xl font-bold mb-4">Cleaning Route Optimizer</h1>

        {/* API key input */}
        <div className="mb-4">
          <label className="block font-semibold">Google Maps Setup</label>
          <input
            className="border p-1 w-full"
            placeholder="Enter API key"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
          />
        </div>

        {/* Depot input */}
        <div className="mb-4">
          <label className="block font-semibold">Depot</label>
          <input
            className="border p-1 w-full"
            placeholder="Depot address"
            value={depot.address}
            onChange={e => setDepot({ ...depot, address: e.target.value })}
          />
          <button
            className="bg-blue-500 text-white px-2 py-1 mt-1 rounded"
            onClick={() =>
              geocodeAddress(depot.address, coords => {
                if (coords) setDepot({ ...depot, ...coords });
              })
            }
          >
            Geocode
          </button>
        </div>

        {/* Add client */}
        <div className="mb-4">
          <label className="block font-semibold">Add Client</label>
          <input id="cname" className="border p-1 w-full" placeholder="Client name" />
          <input id="caddr" className="border p-1 w-full mt-1" placeholder="Client address" />
          <button
            className="bg-green-500 text-white px-2 py-1 mt-1 rounded"
            onClick={() => {
              const name = document.getElementById("cname").value;
              const addr = document.getElementById("caddr").value;
              const client = { id: Date.now().toString(), name, address: addr, lat: null, lng: null };
              setClients(prev => [...prev, client]);
            }}
          >
            Add
          </button>
        </div>

        {/* Clients list with Delete */}
        <div className="mb-4">
          <label className="block font-semibold">Clients</label>
          <div className="space-y-2">
            {clients.map(c => (
              <div key={c.id} className="border p-2 rounded">
                <strong>{c.name}</strong><br />
                {c.address}<br />
                {c.lat && c.lng ? (
                  <span className="text-green-600">Geocoded ✓</span>
                ) : (
                  <button
                    className="text-blue-600 underline text-sm"
                    onClick={() =>
                      geocodeAddress(c.address, coords => {
                        if (coords) {
                          setClients(prev =>
                            prev.map(x => (x.id === c.id ? { ...x, ...coords } : x))
                          );
                        } else {
                          alert("Geocode failed");
                        }
                      })
                    }
                  >
                    Geocode
                  </button>
                )}
                <br />
                <button
                  className="text-red-600 underline text-sm mt-1"
                  onClick={() =>
                    setClients(prev => prev.filter(x => x.id !== c.id))
                  }
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Parameters */}
        <div className="mb-4">
          <label className="block font-semibold">Teams</label>
          <input
            type="number"
            value={teams}
            className="border p-1 w-full"
            onChange={e => setTeams(parseInt(e.target.value))}
          />
        </div>
        <div className="mb-4">
          <label className="block font-semibold">Days to plan</label>
          <input
            type="number"
            value={days}
            className="border p-1 w-full"
            onChange={e => setDays(parseInt(e.target.value))}
          />
        </div>
        <div className="mb-4">
          <label className="block font-semibold">Start date</label>
          <input
            type="date"
            value={startDate}
            className="border p-1 w-full"
            onChange={e => setStartDate(e.target.value)}
          />
        </div>

        <button
          className="bg-purple-600 text-white px-3 py-2 rounded"
          onClick={generateSchedule}
        >
          Generate Schedule
        </button>

        {/* Route details */}
        {selectedRoute && (
          <div className="mt-4">
            <h2 className="font-semibold">Route Details</h2>
            <ul className="list-disc list-inside">
              {selectedRoute.stops.map(s => (
                <li key={s.id}>{s.name} – {s.address}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Right: map */}
      <div className="flex-1">
        {isLoaded && apiKey ? (
          <GoogleMap
            mapContainerStyle={{ width: "100%", height: "100%" }}
            center={
              depot.lat && depot.lng ? { lat: depot.lat, lng: depot.lng } : { lat: 47.6, lng: -117.4 }
            }
            zoom={9}
          >
            {depot.lat && <Marker position={{ lat: depot.lat, lng: depot.lng }} label="D" />}
            {clients.map(c => c.lat && c.lng && (
              <Marker key={c.id} position={{ lat: c.lat, lng: c.lng }} />
            ))}
            {dirResponse && <DirectionsRenderer directions={dirResponse} />}
          </GoogleMap>
        ) : (
          <div className="flex items-center justify-center h-full">
            Enter an API key to enable live maps and directions.
          </div>
        )}
      </div>
    </div>
  );
}
