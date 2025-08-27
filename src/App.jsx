import React, { useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, Marker, DirectionsRenderer, useJsApiLoader } from "@react-google-maps/api";

/** Minimal helpers (no external deps) **/
const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ESWA_BOUNDS = { north: 49.0, south: 45.5, east: -116.0, west: -121.5 };
const MAP_STYLE = { width: "100%", height: "100%" };

function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0);
}
function minutesToTime(mins) {
  const m = Math.max(0, Math.round(mins)); const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0"); return `${String(h).padStart(2, "0")}:${mm}`;
}
function haversineKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180, lat2 = (b.lat * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2)); return R * c;
}
function travelMinutesApprox(a, b) { return (haversineKm(a, b) / 55) * 60; } // ~55 km/h

function nextNDates(startISO, n) {
  const out = []; const start = new Date(startISO);
  for (let i = 0; i < n; i++) { const d = new Date(start); d.setDate(start.getDate() + i); out.push(d); }
  return out;
}
function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
function startOfWeekMs(d) { const c = new Date(d.getFullYear(), d.getMonth(), d.getDate()); c.setDate(c.getDate() - c.getDay()); c.setHours(0,0,0,0); return +c; }
function firstWeekdayOfMonth(year, month, weekday) { const d = new Date(year, month, 1); while (d.getDay() !== weekday) d.setDate(d.getDate()+1); d.setHours(0,0,0,0); return d; }

function isVisitScheduledOn(date, client, epochMondayMs) {
  const day = date.getDay();
  const prefersDay = client.preferredDays.length === 0 || client.preferredDays.includes(day);
  if (!prefersDay) return false;
  switch (client.frequency) {
    case "weekly": return true;
    case "biweekly": {
      const weekMs = 7 * 24 * 3600 * 1000;
      const idx = Math.floor((startOfWeekMs(date) - epochMondayMs) / weekMs);
      return idx % 2 === 0;
    }
    case "monthly": {
      const candidate = firstWeekdayOfMonth(date.getFullYear(), date.getMonth(), client.preferredDays[0] ?? day);
      return sameDay(candidate, date);
    }
    default: return false;
  }
}

function angleAround(depot, p) { return Math.atan2(p.lat - depot.lat, p.lng - depot.lng); }
function partitionByAngle(depot, points, k) {
  const withAngles = points.map(p => ({...p, __a: angleAround(depot,p)})).sort((a,b)=>a.__a-b.__a);
  const groups = Array.from({length: k}, ()=>[]); withAngles.forEach((p,i)=>groups[i%k].push(p));
  return groups.map(g => g.map(({__a, ...rest}) => rest));
}
function orderByNearest(depot, pts) {
  const left = [...pts], out=[]; let cur=depot;
  while (left.length) {
    let bi=0, bc=Infinity; for (let i=0;i<left.length;i++){const c=travelMinutesApprox(cur,left[i]); if(c<bc){bc=c;bi=i;}}
    out.push(left.splice(bi,1)[0]); cur=out[out.length-1];
  }
  return out;
}
function simulateTimeline(depot, stops) {
  const dayStart = 8*60; let t = dayStart, c=depot;
  return stops.map(s=>{
    const drive = travelMinutesApprox(c, s);
    let arrival = t + drive; if (arrival < s.windowStart) arrival = s.windowStart;
    const start = arrival, end = start + (s.durationMin || 60);
    t = end; c = s;
    return {...s, plannedStart: start, plannedEnd: end};
  });
}
function routeDriveMinutes(depot, stops, back=true) {
  let sum=0, c=depot; for (const s of stops){ sum += travelMinutesApprox(c,s); c=s; }
  if (back && stops.length) sum += travelMinutesApprox(c, depot); return sum;
}

/** Build visits for a date **/
function buildDailyVisits(date, clients, epochMondayMs) {
  const visits=[];
  for (const c of clients) {
    if (!c.lat || !c.lng) continue;
    if (isVisitScheduledOn(date, c, epochMondayMs)) {
      visits.push({
        clientId: c.id, name: c.name, address: c.address, lat: c.lat, lng: c.lng,
        durationMin: c.durationMin || 60,
        windowStart: timeToMinutes(c.windowStart) ?? 8*60,
        windowEnd: timeToMinutes(c.windowEnd) ?? 17*60
      });
    }
  }
  return visits;
}

/** Plan a single day into K routes **/
function planDay(depot, visits, teamCount) {
  const clusters = partitionByAngle(depot, visits, teamCount);
  return clusters.map((cluster, i) => {
    const stops = orderByNearest(depot, cluster);
    const timed = simulateTimeline(depot, stops);
    return { teamId: i+1, depot, stops: timed, totalMinutes: routeDriveMinutes(depot, timed) + (timed.length? timed[timed.length-1].plannedEnd - 8*60 : 0) };
  });
}

/** Suggest reschedule slots: try inserting client into every team/position and pick the lowest added drive time **/
function suggestReschedule({ plan, toDateKey, depot, teamCount, client }) {
  const dayRoutes = plan[toDateKey] || Array.from({length: teamCount}, (_,i)=>({ teamId: i+1, depot, stops: [] }));
  const options=[];
  for (const r of dayRoutes) {
    const base = routeDriveMinutes(depot, r.stops);
    for (let i=0; i<=r.stops.length; i++) {
      const newStops = [...r.stops.slice(0,i),
        {
          clientId: client.id, name: client.name, address: client.address,
          lat: client.lat, lng: client.lng,
          durationMin: client.durationMin || 60,
          windowStart: timeToMinutes(client.windowStart) ?? 8*60,
          windowEnd: timeToMinutes(client.windowEnd) ?? 17*60
        },
        ...r.stops.slice(i)];
      const newDrive = routeDriveMinutes(depot, newStops);
      const delta = newDrive - base;
      const timeline = simulateTimeline(depot, newStops);
      const feasible = timeline.every(s => s.plannedStart >= s.windowStart && s.plannedEnd <= s.windowEnd + 60);
      options.push({ teamId: r.teamId, index: i, addedMinutes: delta, feasible, timeline });
    }
  }
  options.sort((a,b)=>a.addedMinutes - b.addedMinutes);
  return options.slice(0,5);
}

export default function App() {
  /** Maps setup **/
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "");
  const { isLoaded, loadError } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: apiKey || "",
    libraries: apiKey ? ["places"] : []
  });

  /** Data **/
  const [depot, setDepot] = useState({ name: "Spokane Depot", address: "Spokane, WA", lat: 47.6588, lng: -117.4260 });
  const [clients, setClients] = useState([
    { id: "c1", name: "Riverfront Suites", address: "507 N Howard St, Spokane, WA", lat: 47.6611, lng: -117.4202, frequency: "weekly", preferredDays: [1,3], windowStart: "09:00", windowEnd: "17:00", durationMin: 90 },
    { id: "c2", name: "Yakima Orchards", address: "14 S 1st St, Yakima, WA", lat: 46.6011, lng: -120.5059, frequency: "biweekly", preferredDays: [2,4], windowStart: "08:30", windowEnd: "16:30", durationMin: 120 },
    { id: "c3", name: "Kennewick Labs", address: "1010 W Canal Dr, Kennewick, WA", lat: 46.2100, lng: -119.1661, frequency: "weekly", preferredDays: [1,2,3,4,5], windowStart: "10:00", windowEnd: "18:00", durationMin: 60 }
  ]);
  const [teamCount, setTeamCount] = useState(2);
  const [horizonDays, setHorizonDays] = useState(7);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0,10));

  /** Plan state **/
  const [plan, setPlan] = useState({});
  const [selectedDateKey, setSelectedDateKey] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState(1);
  const [dirResponse, setDirResponse] = useState(null);
  const mapRef = useRef(null);

  /** Reschedule UI **/
  const [reschedClientId, setReschedClientId] = useState("");
  const [reschedDate, setReschedDate] = useState("");
  const [reschedOptions, setReschedOptions] = useState([]);

  /** Derived: selected route **/
  const selectedRoute = useMemo(() => {
    const routes = plan[selectedDateKey] || [];
    return routes.find(r => r.teamId === Number(selectedTeamId));
  }, [plan, selectedDateKey, selectedTeamId]);

  /** Build schedule **/
  function handleGenerate() {
    const epochMonday = startOfWeekMs(new Date(startDate));
    const dates = nextNDates(startDate, Number(horizonDays));
    const out = {};
    for (const d of dates) {
      const visits = buildDailyVisits(d, clients, epochMonday);
      out[d.toDateString()] = planDay(depot, visits, Number(teamCount));
    }
    setPlan(out);
    const firstKey = dates[0]?.toDateString(); setSelectedDateKey(firstKey || "");
    setSelectedTeamId(1);
  }

  /** Directions render for selected route **/
  useEffect(() => {
    if (!selectedRoute || !isLoaded || !apiKey || !window?.google?.maps || !selectedRoute.stops.length) {
      setDirResponse(null); return;
    }
    const origin = { lat: depot.lat, lng: depot.lng };
    const waypoints = selectedRoute.stops.slice(0, -1).map(s => ({ location: { lat: s.lat, lng: s.lng }, stopover: true }));
    const destination = { lat: selectedRoute.stops[selectedRoute.stops.length-1].lat, lng: selectedRoute.stops[selectedRoute.stops.length-1].lng };
    const svc = new window.google.maps.DirectionsService();
    svc.route(
      { origin, destination, waypoints, optimizeWaypoints: true, travelMode: window.google.maps.TravelMode.DRIVING, region: "US" },
      (result, status) => { if (status === "OK" && result) setDirResponse(result); else setDirResponse(null); }
    );
  }, [selectedRoute, depot, isLoaded, apiKey]);

  /** Geocoding helper **/
  function geocodeAddress(address, cb) {
    if (!isLoaded || !apiKey || !window?.google?.maps) { cb(null); return; }
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ address, bounds: ESWA_BOUNDS }, (results, status) => {
      if (status === "OK" && results?.[0]) {
        const loc = results[0].geometry.location;
        cb({ lat: loc.lat(), lng: loc.lng(), formatted: results[0].formatted_address });
      } else cb(null);
    });
  }

  /** Reschedule: suggest slots **/
  function handleSuggestReschedule() {
    const c = clients.find(x => x.id === reschedClientId);
    if (!c || !reschedDate) return;
    const key = new Date(reschedDate).toDateString();
    const opts = suggestReschedule({ plan, toDateKey: key, depot, teamCount: Number(teamCount), client: c });
    setReschedOptions(opts);
  }
  function applyReschedule(opt) {
    const c = clients.find(x => x.id === reschedClientId);
    if (!c || !reschedDate) return;
    const key = new Date(reschedDate).toDateString();
    const dayRoutes = (plan[key] ? JSON.parse(JSON.stringify(plan[key])) : Array.from({length: Number(teamCount)}, (_,i)=>({teamId:i+1,depot,stops:[]})));
    const idx = dayRoutes.findIndex(r => r.teamId === opt.teamId);
    dayRoutes[idx].stops = opt.timeline; // already simulated with times
    setPlan(prev => ({ ...prev, [key]: dayRoutes }));
    setSelectedDateKey(key); setSelectedTeamId(opt.teamId); setReschedOptions([]);
  }

  if (loadError) {
    return <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h2>Google Maps failed to load</h2>
      <p>Verify your API key, website restrictions, and enabled APIs (Maps JavaScript & Geocoding), then refresh.</p>
    </div>;
  }

  return (
    <div className="w-full h-screen grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 bg-gray-100">
      {/* LEFT PANEL */}
      <div className="lg:col-span-1 space-y-4 overflow-y-auto">
        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Google Maps Setup</h2>
          <input className="w-full border rounded px-2 py-1" placeholder="Paste Google Maps API Key"
                 value={apiKey} onChange={e=>setApiKey(e.target.value.trim())}/>
          <p className="text-xs text-gray-600">Tip: also add this key in Vercel env var <code>VITE_GOOGLE_MAPS_API_KEY</code> for permanent use.</p>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Depot</h2>
          <input className="w-full border rounded px-2 py-1" placeholder="Depot name"
                 value={depot.name} onChange={e=>setDepot({...depot, name: e.target.value})}/>
          <div className="flex gap-2">
            <input className="flex-1 border rounded px-2 py-1" placeholder="Depot address"
                   value={depot.address} onChange={e=>setDepot({...depot, address: e.target.value})}/>
            <button className="px-3 py-1 rounded bg-blue-600 text-white"
                    onClick={()=>geocodeAddress(depot.address, res=>{
                      if(res) setDepot({...depot, lat: res.lat, lng: res.lng, address: res.formatted});
                      else alert("Geocoding failed."); })}>Geocode</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="border rounded px-2 py-1" value={depot.lat ?? ""} placeholder="Lat"
                   onChange={e=>setDepot({...depot, lat: parseFloat(e.target.value)})}/>
            <input className="border rounded px-2 py-1" value={depot.lng ?? ""} placeholder="Lng"
                   onChange={e=>setDepot({...depot, lng: parseFloat(e.target.value)})}/>
          </div>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Add Client</h2>
          <input id="cname" className="w-full border rounded px-2 py-1" placeholder="Client name"/>
          <div className="flex gap-2">
            <input id="caddr" className="flex-1 border rounded px-2 py-1" placeholder="Client address"/>
            <button className="px-3 py-1 rounded bg-emerald-600 text-white"
                    onClick={()=>{
                      const name = document.getElementById("cname").value.trim();
                      const addr = document.getElementById("caddr").value.trim();
                      if(!name || !addr) return;
                      setClients(prev=>[...prev, {
                        id: Date.now().toString(), name, address: addr,
                        lat: null, lng: null, frequency:"weekly",
                        preferredDays: [], windowStart:"09:00", windowEnd:"17:00", durationMin:60
                      }]);
                    }}>Add</button>
          </div>
          <p className="text-xs text-gray-600">After adding, click “Geocode” next to the client to pin it.</p>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Clients</h2>
          <div className="space-y-2">
            {clients.map(c=>(
              <div key={c.id} className="border rounded p-2">
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-gray-700">{c.address}</div>
                <div className="text-xs text-gray-600">
                  {c.lat && c.lng ? "Geocoded ✓" : "Not geocoded"}
                </div>
                <div className="flex gap-2 mt-1">
                  <button className="text-xs px-2 py-1 rounded bg-blue-600 text-white"
                          onClick={()=>geocodeAddress(c.address, res=>{
                            if(res) setClients(prev=>prev.map(x=>x.id===c.id? {...x, lat:res.lat, lng:res.lng, address:res.formatted}:x));
                            else alert("Geocoding failed.");})}>Geocode</button>
                  <button className="text-xs px-2 py-1 rounded bg-rose-600 text-white"
                          onClick={()=>setClients(prev=>prev.filter(x=>x.id!==c.id))}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Plan</h2>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Teams
              <input className="w-full border rounded px-2 py-1" type="number" min={1}
                     value={teamCount} onChange={e=>setTeamCount(Number(e.target.value)||1)}/>
            </label>
            <label className="text-sm">Days to plan
              <input className="w-full border rounded px-2 py-1" type="number" min={1}
                     value={horizonDays} onChange={e=>setHorizonDays(Number(e.target.value)||1)}/>
            </label>
            <label className="text-sm col-span-2">Start date
              <input className="w-full border rounded px-2 py-1" type="date"
                     value={startDate} onChange={e=>setStartDate(e.target.value)}/>
            </label>
          </div>
          <button className="w-full py-2 rounded bg-indigo-600 text-white" onClick={handleGenerate}>Generate Schedule</button>
        </div>

        <div className="p-4 rounded-2xl shadow bg-white space-y-2">
          <h2 className="text-lg font-semibold">Reschedule</h2>
          <select className="w-full border rounded px-2 py-1" value={reschedClientId} onChange={e=>setReschedClientId(e.target.value)}>
            <option value="">Select client</option>
            {clients.map(c=> <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input className="w-full border rounded px-2 py-1" type="date" value={reschedDate} onChange={e=>setReschedDate(e.target.value)}/>
          <button className="w-full py-2 rounded bg-amber-600 text-white" onClick={handleSuggestReschedule}>Suggest Slots</button>
          {reschedOptions.length>0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Top suggestions</h3>
              {reschedOptions.map((opt, i)=>(
                <div key={i} className={`border rounded p-2 ${opt.feasible ? "border-emerald-400" : "border-rose-300"}`}>
                  <div className="text-sm">Team {opt.teamId} • +{Math.round(opt.addedMinutes)} min • {opt.feasible ? "Feasible" : "Tight window"}</div>
                  <div className="text-xs text-gray-600">Start ~ {opt.timeline[opt.index] ? minutesToTime(opt.timeline[opt.index].plannedStart) : "—"}</div>
                  <button className="mt-1 text-xs px-2 py-1 rounded bg-blue-600 text-white" onClick={()=>applyReschedule(opt)}>Apply</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MAP + ROUTE DETAILS */}
      <div className="lg:col-span-2 grid grid-rows-6 gap-4">
        <div className="row-span-4 rounded-2xl overflow-hidden shadow relative bg-white">
          {isLoaded && apiKey ? (
            <GoogleMap
              mapContainerStyle={MAP_STYLE}
              center={{ lat: depot.lat || 47.6588, lng: depot.lng || -117.4260 }}
              zoom={7}
              onLoad={(m)=> (mapRef.current = m)}
              options={{ restriction: { latLngBounds: ESWA_BOUNDS, strictBounds: false } }}
            >
              <Marker position={{ lat: depot.lat, lng: depot.lng }} label="D" />
              {(plan[selectedDateKey]?.flatMap(r=>r.stops) || clients.filter(c=>c.lat && c.lng)).map((s, idx)=>(
                <Marker key={idx} position={{ lat: s.lat, lng: s.lng }} />
              ))}
              {dirResponse && <DirectionsRenderer directions={dirResponse} />}
            </GoogleMap>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              Enter an API key to enable live maps and directions.
            </div>
          )}

          <div className="absolute top-3 left-3 bg-white/90 rounded-xl p-2 shadow flex items-center gap-2">
            <select className="border rounded px-2 py-1" value={selectedDateKey} onChange={e=>setSelectedDateKey(e.target.value)}>
              <option value="">Select day</option>
              {Object.keys(plan).map(k=> <option key={k} value={k}>{k}</option>)}
            </select>
            <select className="border rounded px-2 py-1" value={selectedTeamId} onChange={e=>setSelectedTeamId(Number(e.target.value))}>
              {Array.from({length: Number(teamCount)}, (_,i)=> <option key={i+1} value={i+1}>Team {i+1}</option>)}
            </select>
          </div>
        </div>

        <div className="row-span-2 rounded-2xl shadow bg-white p-4 overflow-y-auto">
          <h2 className="text-lg font-semibold mb-2">Route Details</h2>
          {selectedRoute ? (
            <div className="space-y-2">
              <div className="text-sm text-gray-600">
                Team {selectedRoute.teamId} • Stops {selectedRoute.stops.length}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-1">#</th><th className="py-1">Client</th><th className="py-1">Address</th>
                    <th className="py-1">Window</th><th className="py-1">Planned</th><th className="py-1">Dur</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRoute.stops.map((s,i)=>(
                    <tr key={i} className="border-b">
                      <td className="py-1 pr-2">{i+1}</td>
                      <td className="py-1 pr-2">{s.name}</td>
                      <td className="py-1 pr-2">{s.address}</td>
                      <td className="py-1 pr-2">{minutesToTime(s.windowStart)}–{minutesToTime(s.windowEnd)}</td>
                      <td className="py-1 pr-2">{minutesToTime(s.plannedStart||0)}–{minutesToTime(s.plannedEnd||0)}</td>
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
