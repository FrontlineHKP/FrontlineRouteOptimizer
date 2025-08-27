import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Marker, DirectionsRenderer, useJsApiLoader } from "@react-google-maps/api";

const defaultDepot = {
  name: "Spokane Depot",
  lat: 47.6588,
  lng: -117.4260,
  address: "Spokane, WA"
};

const eswaBounds = {
  north: 49.0,
  south: 45.5,
  east: -116.0,
  west: -121.5
};

const containerStyle = { width: "100%", height: "100%" };

const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${String(h).padStart(2, "0")}:${mm}`;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2));
  return R * c;
}

function travelMinutesApprox(a, b) {
  const km = haversineKm(a, b);
  return (km / 55) * 60;
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function nextNDays(startDate, n) {
  const out = [];
  const start = new Date(startDate);
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(d);
  }
  return out;
}

function isVisitScheduledOn(date, client, epochMonday) {
  const day = date.getDay();
  const prefersDay = client.preferredDays.length === 0 || client.preferredDays.includes(day);
  if (!prefersDay) return false;

  switch (client.frequency) {
    case "weekly":
      return true;
    case "biweekly": {
      const msPerWeek = 7 * 24 * 3600 * 1000;
      const weekIndex = Math.floor((startOfWeek(date) - epochMonday) / msPerWeek);
      return weekIndex % 2 === 0;
    }
    case "monthly": {
      const month = date.getMonth();
      const year = date.getFullYear();
      const candidate = firstWeekdayOfMonth(year, month, client.preferredDays[0] ?? day);
      return sameDay(candidate, date);
    }
    default:
      return false;
  }
}

function startOfWeek(d) {
  const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = c.getDay();
  c.setDate(c.getDate() - day); // Sunday
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

function firstWeekdayOfMonth(year, month, weekday) {
  const d = new Date(year, month, 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function angle(depot, p) { return Math.atan2(p.lat - depot.lat, p.lng - depot.lng); }

function partitionByAngle(depot, points, k) {
  if (points.length === 0) return Array.from({ length: k }, () => []);
  const withAngles = points.map((p) => ({ ...p, __angle: angle(depot, p) }));
  withAngles.sort((a, b) => a.__angle - b.__angle);
  const clusters = Array.from({ length: k }, () => []);
  withAngles.forEach((item, idx) => { clusters[idx % k].push(item); });
  return clusters.map((c) => c.map(({ __angle, ...rest }) => rest));
}

function orderByNearest(depot, pts) {
  const remaining = [...pts];
  const ordered = [];
  let cur = depot;
  while (remaining.length) {
    let bestIdx = 0, bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const r = remaining[i];
      const cost = travelMinutesApprox(cur, r);
      if (cost < bestCost) { bestCost = cost; bestIdx = i; }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
    cur = ordered[ordered.length - 1];
  }
  return ordered;
}

function buildDailyVisits(date, clients, epochMonday) {
  const visits = [];
  clients.forEach((c) => {
    if (!c.lat || !c.lng) return;
    if (isVisitScheduledOn(date, c, epochMonday)) {
      visits.push({
        clientId: c.id,
        name: c.name,
        lat: c.lat, lng: c.lng,
        durationMin: c.durationMin || 60,
        windowStart: timeToMinutes(c.windowStart) ?? 8 * 60,
        windowEnd: timeToMinutes(c.windowEnd) ?? 17 * 60,
        address: c.address
      });
    }
  });
  return visits;
}

function planDay(depot, visits, teamCount) {
  const clusters = partitionByAngle(depot, visits, teamCount);
  const teamRoutes = clusters.map((cluster, idx) => {
    const stops = orderByNearest(depot, cluster);
    const dayStart = 8 * 60;
    let t = dayStart;
    let cursor = depot;
    const withTimes = stops.map((s) => {
      const drive = travelMinutesApprox(cursor, s);
      let arrival = t + drive;
      if (arrival < s.windowStart) arrival = s.windowStart;
      const start = arrival;
      const end = start + (s.durationMin || 60);
      t = end;
      cursor = s;
      return { ...s, plannedStart: start, plannedEnd: end };
    });
    const totalDriveBack = withTimes.length ? travelMinutesApprox(withTimes[withTimes.length - 1], depot) : 0;
    return { teamId: idx + 1, stops: withTimes, depot, totalMinutes: t - dayStart + totalDriveBack };
  });
  return teamRoutes;
}

function planSchedule({ depot, clients, startDate, days, teamCount }) {
  const epochMonday = startOfWeek(new Date(startDate));
  const dates = nextNDays(startDate, days);
  const plan = {};
  dates.forEach((date) => {
    const visits = buildDailyVisits(date, clients, epochMonday);
    plan[date.toDateString()] = planDay(depot, visits, teamCount);
  });
  return plan;
}

function suggestReschedule({ plan, toDate, client, teamCount, depot }) {
  const toKey = toDate.toDateString();
  const dayRoutes = clone(plan[toKey] || Array.from({ length: teamCount }, (_, i) => ({ teamId: i + 1, stops: [], depot })));
  const options = [];
  for (let r = 0; r < dayRoutes.length; r++) {
    const route = dayRoutes[r];
    const baseDrive = routeDriveMinutes(depot, route.stops, depot);
    for (let i = 0; i <= route.stops.length; i++) {
      const newStops = [...route.stops.slice(0, i),
        {
          clientId: client.id,
          name: client.name,
          lat: client.lat, lng: client.lng,
          durationMin: client.durationMin || 60,
          windowStart: timeToMinutes(client.windowStart) ?? 8 * 60,
          windowEnd: timeToMinutes(client.windowEnd) ?? 17 * 60,
          address: client.address
        },
        ...route.stops.slice(i)
      ];
      const newDrive = routeDriveMinutes(depot, newStops, depot);
      const delta = newDrive - baseDrive;
      const timeline = simulateTimeline(depot, newStops);
      const feasible = timeline.every((s) => s.plannedStart >= s.windowStart && s.plannedEnd <= s.windowEnd + 60);
      options.push({ teamId: route.teamId, index: i, addedMinutes: delta, feasible, timeline });
    }
  }
  options.sort((a, b) => a.addedMinutes - b.addedMinutes);
  return options.slice(0, 5);
}

function routeDriveMinutes(depot, stops, depotEnd) {
  let sum = 0, cur = depot;
  for (const s of stops) { sum += travelMinutesApprox(cur, s); cur = s; }
  if (depotEnd) sum += travelMinutesApprox(cur, depotEnd);
  return sum;
}

function simulateTimeline(depot, stops) {
  const dayStart = 8 * 60;
  let t = dayStart, cursor = depot;
  return stops.map((s) => {
    const drive = travelMinutesApprox(cursor, s);
    let arrival = t + drive;
    if (arrival < s.windowStart) arrival = s.windowStart;
    const start = arrival, end = start + (s.durationMin || 60);
    t = end; cursor = s;
    return { ...s, plannedStart: start, plannedEnd: end };
  });
}

export default function App() {
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "");
  const { isLoaded } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: apiKey || "",
    libraries: apiKey ? ["places"] : []
  });

  const [depot, setDepot] = useState(defaultDepot);
  const [clients, setClients] = useState(() => [
    { id: "c1", name: "Riverfront Suites", address: "507 N Howard St, Spokane, WA", lat: 47.6611, lng: -117.4202, frequency: "weekly", preferredDays: [1,3], windowStart: "09:00", windowEnd: "17:00", durationMin: 90 },
    { id: "c2", name: "Yakima Orchards", address: "14 S 1st St, Yakima, WA", lat: 46.6011, lng: -120.5059, frequency: "biweekly", preferredDays: [2,4], windowStart: "08:30", windowEnd: "16:30", durationMin: 120 },
    { id: "c3", name: "Kennewick Labs", address: "1010 W Canal Dr, Kennewick, WA", lat: 46.2100, lng: -119.1661, frequency: "weekly", preferredDays: [1,2,3,4,5], windowStart: "10:00", windowEnd: "18:00", durationMin: 60 },
  ]);

  const [newClient, setNewClient] = useState({
    name: "", address: "", lat: null, lng: null,
    frequency: "weekly", preferredDays: [],
    windowStart: "09:00", windowEnd: "17:00", durationMin: 60
  });
  const [teamCount, setTeamCount] = useState(2);
  const [horizonDays, setHorizonDays] = useState(7);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0,10));
  const [plan, setPlan] = useState({});
  const [selectedDateStr, setSelectedDateStr] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState(1);
  const [showDirections, setShowDirections] = useState(true);
  const [reschedClientId, setReschedClientId] = useState("");
  const [reschedDate, setReschedDate] = useState("");
  const [reschedOptions, setReschedOptions] = useState([]);
  const mapRef = useRef(null);
  const [dirResponse, setDirResponse] = useState(null);

  const selectedRoute = useMemo(() => {
    const dayRoutes = plan[selectedDateStr] || [];
    return dayRoutes.find((r) => r.teamId === Number(selectedTeamId));
  }, [plan, selectedDateStr, selectedTeamId]);

  useEffect(() => {
    if (!selectedRoute || !isLoaded) { setDirResponse(null); return; }
    if (!apiKey) { setDirResponse(null); return; }
    if (!selectedRoute.stops.length) { setDirResponse(null); return; }

    const waypoints = selectedRoute.stops.slice(0, -1).map((s) => ({
      location: { lat: s.lat, lng: s.lng }, stopover: true
    }));
    const origin = { lat: depot.lat, lng: depot.lng };
    const destination = { lat: selectedRoute.stops[selectedRoute.stops.length - 1].lat, lng: selectedRoute.stops[selectedRoute.stops.length - 1].lng };
    const directionsService = new window.google.maps.DirectionsService();
    directionsService.route(
      {
        origin, destination, waypoints,
        optimizeWaypoints: true,
        travelMode: window.google.maps.TravelMode.DRIVING,
        provideRouteAlternatives: false, region: "US"
      },
      (result, status) => {
        if (status === "OK" && result) setDirResponse(result);
        else setDirResponse(null);
      }
    );
  }, [selectedRoute, depot, isLoaded, apiKey]);

  function geocodeAddress(address, cb) {
    if (!isLoaded || !apiKey || !window.google) { cb(null); return; }
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ address, bounds: eswaBounds }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const loc = results[0].geometry.location;
        cb({ lat: loc.lat(), lng: loc.lng(), formatted: results[0].formatted_address });
      } else cb(null);
    });
  }

  function handleAddClient() {
    if (!newClient.name || !newClient.address) return;
    const id = `c${Math.random().toString(36).slice(2,8)}`;
    setClients((prev) => [...prev, { id, ...newClient }]);
    setNewClient({ name: "", address: "", lat: null, lng: null, frequency: "weekly", preferredDays: [], windowStart: "09:00", windowEnd: "17:00", durationMin: 60 });
  }

  function handlePlan() {
    const p = planSchedule({ depot, clients, startDate: new Date(startDate), days: Number(horizonDays), teamCount: Number(teamCount) });
    setPlan(p);
    const firstDate = Object.keys(p)[0] || new Date(startDate).toDateString();
    setSelectedDateStr(firstDate);
    setSelectedTeamId(1);
  }

  function handleSuggestReschedule() {
    const client = clients.find((c) => c.id === reschedClientId);
    if (!client || !reschedDate) return;
    const options = suggestReschedule({ plan, toDate: new Date(reschedDate), client, teamCount: Number(teamCount), depot });
    setReschedOptions(options);
  }

  function applyReschedule(option) {
    const client = clients.find((c) => c.id === reschedClientId);
    if (!client || !reschedDate) return;
    const toKey = new Date(reschedDate).toDateString();
    const dayRoutes = clone(plan[toKey] || Array.from({ length: Number(teamCount) }, (_, i) => ({ teamId: i + 1, stops: [], depot })));
    const routeIdx = dayRoutes.findIndex((r) => r.teamId === option.teamId);
    const newStop = {
      clientId: client.id, name: client.name,
      lat: client.lat, lng: client.lng,
      durationMin: client.durationMin || 60,
      windowStart: timeToMinutes(client.windowStart) ?? 8 * 60,
      windowEnd: timeToMinutes(client.windowEnd) ?? 17 * 60,
      address: client.address
    };
    dayRoutes[routeIdx].stops.splice(option.index, 0, newStop);
    const timeline = simulateTimeline(depot, dayRoutes[routeIdx].stops);
    dayRoutes[routeIdx].stops = timeline;
    setPlan((prev) => ({ ...prev, [toKey]: dayRoutes }));
    setSelectedDateStr(toKey); setSelectedTeamId(option.teamId);
    setReschedOptions([]);
  }

  const center = useMemo(() => ({ lat: depot.lat, lng: depot.lng }), [depot]);

  return (
    <div className="w-full h-[100vh] grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
      <div className="lg:col-span-1 space-y-4 overflow-y-auto">
        <div className="p-4 rounded-2xl shadow bg-white space-y-3">
          <h2 className="text-xl font-semibold">Google Maps Setup</h2>
          <input
            className="w-full border rounded px-3 py-2"
            placeholder="Paste Google Maps JavaScript API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value.trim())}
          />
          <p className="text-sm text-gray-600">Maps, geocoding, and live directions require an API key. Without it, the app uses approximate distances.</p>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-3">
          <h2 className="text-xl font-semibold">Depot</h2>
          <div className="flex gap-2">
            <input className="flex-1 border rounded px-3 py-2" value={depot.name} onChange={(e) => setDepot({ ...depot, name: e.target.value })} placeholder="Depot name"/>
          </div>
          <div className="flex gap-2">
            <input className="flex-1 border rounded px-3 py-2" value={depot.address} onChange={(e) => setDepot({ ...depot, address: e.target.value })} placeholder="Depot address"/>
            <button
              className="px-3 py-2 rounded bg-blue-600 text-white"
              onClick={() => geocodeAddress(depot.address, (res) => {
                if (res) setDepot({ ...depot, lat: res.lat, lng: res.lng, address: res.formatted });
                else alert("Geocoding failed. Check API key and address.");
              })}
            >Geocode</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded px-3 py-2" value={depot.lat} onChange={(e) => setDepot({ ...depot, lat: parseFloat(e.target.value) })} placeholder="Lat"/>
            <input className="border rounded px-3 py-2" value={depot.lng} onChange={(e) => setDepot({ ...depot, lng: parseFloat(e.target.value) })} placeholder="Lng"/>
          </div>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-4">
          <h2 className="text-xl font-semibold">Add Client</h2>
          <input className="w-full border rounded px-3 py-2" placeholder="Client name" value={newClient.name} onChange={(e)=>setNewClient({...newClient, name: e.target.value})} />
          <div className="flex gap-2">
            <input className="flex-1 border rounded px-3 py-2" placeholder="Address" value={newClient.address} onChange={(e)=>setNewClient({...newClient, address: e.target.value})} />
            <button className="px-3 py-2 rounded bg-blue-600 text-white" onClick={()=>geocodeAddress(newClient.address, (res)=>{
              if(res) setNewClient({...newClient, lat: res.lat, lng: res.lng, address: res.formatted});
              else alert("Geocoding failed.");
            })}>Geocode</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded px-3 py-2" placeholder="Lat" value={newClient.lat ?? ''} onChange={(e)=>setNewClient({...newClient, lat: parseFloat(e.target.value)})} />
            <input className="border rounded px-3 py-2" placeholder="Lng" value={newClient.lng ?? ''} onChange={(e)=>setNewClient({...newClient, lng: parseFloat(e.target.value)})} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className="border rounded px-3 py-2" value={newClient.frequency} onChange={(e)=>setNewClient({...newClient, frequency: e.target.value})}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
            </select>
            <input className="border rounded px-3 py-2" placeholder="Duration (min)" type="number" value={newClient.durationMin} onChange={(e)=>setNewClient({...newClient, durationMin: Number(e.target.value)})} />
          </div>
          <div>
            <label className="text-sm font-medium">Preferred Days</label>
            <div className="grid grid-cols-7 gap-1 mt-1">
              {weekdayNames.map((w, idx)=> (
                <label key={w} className="flex items-center gap-1 text-sm border rounded px-2 py-1">
                  <input type="checkbox" checked={newClient.preferredDays.includes(idx)} onChange={(e)=>{
                    const next = new Set(newClient.preferredDays);
                    if(e.target.checked) next.add(idx); else next.delete(idx);
                    setNewClient({...newClient, preferredDays: Array.from(next).sort((a,b)=>a-b)});
                  }} />{w}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded px-3 py-2" placeholder="Window start (e.g., 09:00)" value={newClient.windowStart} onChange={(e)=>setNewClient({...newClient, windowStart: e.target.value})} />
            <input className="border rounded px-3 py-2" placeholder="Window end (e.g., 17:00)" value={newClient.windowEnd} onChange={(e)=>setNewClient({...newClient, windowEnd: e.target.value})} />
          </div>
          <button className="w-full py-2 rounded bg-emerald-600 text-white" onClick={handleAddClient}>Add Client</button>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-3">
          <h2 className="text-xl font-semibold">Plan</h2>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Teams
              <input className="w-full border rounded px-3 py-2" type="number" min={1} value={teamCount} onChange={(e)=>setTeamCount(Number(e.target.value))} />
            </label>
            <label className="text-sm">Days to plan
              <input className="w-full border rounded px-3 py-2" type="number" min={1} value={horizonDays} onChange={(e)=>setHorizonDays(Number(e.target.value))} />
            </label>
            <label className="text-sm col-span-2">Start date
              <input className="w-full border rounded px-3 py-2" type="date" value={startDate} onChange={(e)=>setStartDate(e.target.value)} />
            </label>
          </div>
          <button className="w-full py-2 rounded bg-indigo-600 text-white" onClick={handlePlan}>Generate Schedule</button>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-3">
          <h2 className="text-xl font-semibold">Reschedule</h2>
          <select className="w-full border rounded px-3 py-2" value={reschedClientId} onChange={(e)=>setReschedClientId(e.target.value)}>
            <option value="">Select client</option>
            {clients.map(c=> <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="w-full border rounded px-3 py-2" type="date" value={reschedDate} onChange={(e)=>setReschedDate(e.target.value)} />
          <button className="w-full py-2 rounded bg-amber-600 text-white" onClick={handleSuggestReschedule}>Suggest Slots</button>
          {reschedOptions.length>0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Top suggestions</h3>
              {reschedOptions.map((opt, idx)=> (
                <div key={idx} className={`border rounded p-2 ${opt.feasible? 'border-emerald-400' : 'border-rose-300'}`}>
                  <div className="text-sm">Team {opt.teamId} • +{Math.round(opt.addedMinutes)} min • {opt.feasible? 'Feasible' : 'Tight window'}</div>
                  <div className="text-xs text-gray-600">Start ~ {opt.timeline[opt.index] ? minutesToTime(opt.timeline[opt.index].plannedStart) : '—'}</div>
                  <button className="mt-1 text-xs px-2 py-1 rounded bg-blue-600 text-white" onClick={()=>applyReschedule(opt)}>Apply</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-2 grid grid-rows-6 gap-4">
        <div className="row-span-4 rounded-2xl overflow-hidden shadow relative">
          {isLoaded && apiKey ? (
            <GoogleMap
              mapContainerStyle={containerStyle}
              center={{ lat: depot.lat, lng: depot.lng }}
              zoom={7}
              onLoad={(map)=> (mapRef.current = map)}
              options={{ restriction: { latLngBounds: eswaBounds, strictBounds: false }}}
            >
              <Marker position={{ lat: depot.lat, lng: depot.lng }} label="D" />
              {(plan[selectedDateStr]?.flatMap(r=> r.stops) || clients.filter(c=>c.lat && c.lng)).map((s, idx) => (
                <Marker key={idx} position={{ lat: s.lat, lng: s.lng }} />
              ))}
              {showDirections && dirResponse && <DirectionsRenderer directions={dirResponse} />}
            </GoogleMap>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-50">
              <div className="text-center">
                <div className="text-2xl font-semibold">Google Map</div>
                <p className="text-gray-600">Enter an API key to enable live maps and directions. Without it, you can still plan with approximate distances.</p>
              </div>
            </div>
          )}
          <div className="absolute top-3 left-3 bg-white/90 rounded-xl p-2 shadow flex items-center gap-2">
            <select className="border rounded px-2 py-1" value={selectedDateStr} onChange={(e)=>setSelectedDateStr(e.target.value)}>
              <option value="">Select day</option>
              {Object.keys(plan).map((d)=> <option key={d} value={d}>{d}</option>)}
            </select>
            <select className="border rounded px-2 py-1" value={selectedTeamId} onChange={(e)=>setSelectedTeamId(Number(e.target.value))}>
              {Array.from({length: Number(teamCount)}, (_,i)=> <option key={i+1} value={i+1}>Team {i+1}</option>)}
            </select>
            <label className="text-sm flex items-center gap-1">
              <input type="checkbox" checked={showDirections} onChange={(e)=>setShowDirections(e.target.checked)} /> Show directions
            </label>
          </div>
        </div>

        <div className="row-span-2 rounded-2xl shadow bg-white p-4 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-2">Route Details</h2>
          {selectedRoute ? (
            <div className="space-y-2">
              <div className="text-sm text-gray-600">Team {selectedRoute.teamId} • Total est. time {Math.round(selectedRoute.totalMinutes)} min</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1">#</th>
                    <th className="py-1">Client</th>
                    <th className="py-1">Address</th>
                    <th className="py-1">Window</th>
                    <th className="py-1">Planned</th>
                    <th className="py-1">Dur</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRoute.stops.map((s, i)=> (
                    <tr key={i} className="border-b">
                      <td className="py-1 pr-2">{i+1}</td>
                      <td className="py-1 pr-2">{s.name}</td>
                      <td className="py-1 pr-2">{s.address}</td>
                      <td className="py-1 pr-2">{minutesToTime(s.windowStart)}–{minutesToTime(s.windowEnd)}</td>
                      <td className="py-1 pr-2">{minutesToTime(s.plannedStart || 0)}–{minutesToTime(s.plannedEnd || 0)}</td>
                      <td className="py-1 pr-2">{s.durationMin}m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-sm text-gray-600">Generate a schedule, then pick a day and team to view details.</div>
          )}
        </div>
      </div>
    </div>
  );
}
