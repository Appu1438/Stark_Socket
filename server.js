const express = require("express");
const { WebSocketServer } = require("ws");
const geolib = require("geolib");
const { getDistance } = require("geolib");
const cors = require('cors')
const app = express();
const PORT = 3000;

// Store driver locations
let drivers = {};
let userSockets = new Set(); // Store all connected users
let adminSockets = new Set(); // store admin sockets

// Create WebSocket server
const wss = new WebSocketServer({ port: 8080, host: "0.0.0.0" });

wss.on("connection", (ws) => {
    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);

            console.log("Received message:", data); // Debugging line
            if (data.role === "user") {
                userSockets.add(ws);

                // Remove closed sockets
                ws.on("close", () => {
                    userSockets.delete(ws);
                });
            }
            if (data.role === "admin") {
                adminSockets.add(ws);

                // Send all drivers immediately
                ws.send(
                    JSON.stringify({
                        type: "allDrivers",
                        drivers: Object.entries(drivers).map(([id, d]) => ({
                            id,
                            current: d.current,
                            heading: d.heading,
                        })),
                    })
                );
                console.log(drivers)


                ws.on("close", () => {
                    adminSockets.delete(ws);
                });
            }


            if (data.type === "locationUpdate" && data.role === "driver") {
                const driverId = data.driver;
                const newLocation = {
                    latitude: data.data.latitude,
                    longitude: data.data.longitude,
                };

                const prevLocation = drivers[driverId]?.current;

                // ⚠️ Only update and broadcast if location has changed
                if (
                    !prevLocation ||
                    prevLocation.latitude !== newLocation.latitude ||
                    prevLocation.longitude !== newLocation.longitude
                ) {
                    let heading = 0;
                    if (prevLocation) {
                        heading = calculateHeading(
                            prevLocation.latitude,
                            prevLocation.longitude,
                            newLocation.latitude,
                            newLocation.longitude
                        );
                    }

                    drivers[driverId] = {
                        previous: prevLocation,
                        current: newLocation,
                        heading: heading,
                    };

                    broadcastDriverLocation(driverId, drivers[driverId]);
                    // 🔹 Also broadcast to admins
                    broadcastToAdmins(driverId, drivers[driverId]);

                    console.log(`Driver ${driverId} location updated:`, drivers[driverId]);
                } else {
                    console.log(`Driver ${driverId} location unchanged — skipping broadcast`);
                }
            }


            if (data.type === "requestRide" && data.role === "user") {
                console.log("Requesting ride...");
                const nearbyDrivers = findNearbyDrivers(data.latitude, data.longitude);
                console.log('drivers', nearbyDrivers)

                if (nearbyDrivers.length === 0) {
                    ws.send(
                        JSON.stringify({
                            type: "nearbyDrivers",
                            drivers: [],
                            message: "No nearby drivers found",
                        })
                    );
                } else {
                    ws.send(
                        JSON.stringify({
                            type: "nearbyDrivers",
                            drivers: nearbyDrivers,
                        })
                    );
                }
            }

            // 3. Status update: remove driver if inactive
            if (data.type === "statusUpdate" && data.role === "driver") {
                delete drivers[data.driver];
                console.log(`Driver ${data.driver} removed due to inactivity.`);
                console.log('drivers', drivers)

            }

        } catch (error) {
            console.log("Failed to parse WebSocket message:", error);
        }
    });
});
function broadcastDriverLocation(driverId, driverData) {
    console.log("BroadCasting")
    const payload = {
        type: "driverLocationUpdate",
        drivers: [
            {
                id: driverId,
                current: driverData.current,
                previous: driverData.previous,
                heading: driverData.heading,
            },
        ],
    };

    const message = JSON.stringify(payload);

    userSockets.forEach((user) => {
        if (user.readyState === 1) { // Only send to open connections
            user.send(message);
        }
    });
}
function broadcastToAdmins(driverId, driverData) {
    const payload = {
        type: "driverLocationUpdate",
        drivers: [
            {
                id: driverId,
                current: driverData.current,
                heading: driverData.heading,
            },
        ],
    };
    const msg = JSON.stringify(payload);
    adminSockets.forEach((admin) => {
        if (admin.readyState === 1) admin.send(msg);
    });
}
function calculateHeading(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * (Math.PI / 180);
    const toDeg = rad => rad * (180 / Math.PI);

    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

    let angle = Math.atan2(y, x);
    angle = toDeg(angle);
    return (angle + 360) % 360;
}


const findNearbyDrivers = (userLat, userLon) => {
    return Object.entries(drivers)
        .filter(([id, driver]) => {
            const curr = driver?.current;
            if (
                !curr ||
                curr.latitude == null ||
                curr.longitude == null
            ) {
                return false; // skip if invalid
            }

            const distance = getDistance(
                { latitude: userLat, longitude: userLon },
                curr
            );

            return distance <= 5000; // within 5 km
        })
        .map(([id, driver]) => ({
            id,
            current: driver.current,
            heading: driver.heading ?? 0,
            previous: driver.previous,
        }));
};

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

