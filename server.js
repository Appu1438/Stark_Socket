const express = require("express");
const { WebSocketServer } = require("ws");
const geolib = require("geolib");
const { getDistance } = require("geolib");
const cors = require("cors");
const http = require("http");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

let drivers = {};
let users = new Set();
let adminSockets = new Set();
let driverSockets = new Map(); // store driver WebSocket connections
let userSockets = new Map(); // store users WebSocket connections

// ✅ Create ONE HTTP server and attach both Express + WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {

    // 🔴 ADD CLOSE HANDLER HERE (ONCE)
    ws.on("close", () => {
        
        if (ws.role === "user") {
            users.delete(ws);
            if (ws.userId) userSockets.delete(ws.userId);
        }

        if (ws.role === "driver") {
            driverSockets.delete(ws.driverId);
            delete drivers[ws.driverId];
        }

        if (ws.role === "admin") {
            adminSockets.delete(ws);
        }
    });
    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            console.log("Received message:", data);

            if (data.role === "user") {
                // Always store in general set
                users.add(ws);

                // Optionally store in Map if userId exists
                if (data.userId) {
                    userSockets.set(data.userId, ws);
                }
            }

            if (data.role === "admin") {
                adminSockets.add(ws);

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

            }

            if (data.role === "driver") {
                const driverId = data.driver;
                // Save socket connection for this driver
                driverSockets.set(driverId, ws);

            }

            if (data.type === "locationUpdate" && data.role === "driver") {
                const driverId = data.driver;
                const newLocation = {
                    latitude: data.data.latitude,
                    longitude: data.data.longitude,
                };

                const prevLocation = drivers[driverId]?.current;

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
                        heading,
                    };

                    broadcastDriverLocation(driverId, drivers[driverId]);
                    broadcastToAdmins(driverId, drivers[driverId]);
                }
            }

            if (data.type === "requestDrivers" && data.role === "user") {
                const nearbyDrivers = findNearbyDrivers(data.latitude, data.longitude);
                ws.send(
                    JSON.stringify({
                        type: "nearbyDrivers",
                        drivers: nearbyDrivers,
                        message: nearbyDrivers.length
                            ? undefined
                            : "No nearby drivers found",
                    })
                );
            }

            //Ride Request
            if (data.type === "rideRequest" && data.role === "user") {
                const driverWs = driverSockets.get(data.driverId);
                if (driverWs?.readyState === 1) {
                    driverWs.send(JSON.stringify({ type: "rideRequest", rideRequest: data.rideRequest }));
                }
            }

            // Accept
            if (data.type === "rideAccepted" && data.role === "driver") {
                const userWs = userSockets.get(data.rideData.user.id);
                if (userWs?.readyState === 1) {
                    userWs.send(JSON.stringify({ type: "rideAccepted", rideData: data.rideData }));
                }
            }

            // Reject
            if (data.type === "rideRejected" && data.role === "driver") {
                const userWs = userSockets.get(data.userId);
                if (userWs?.readyState === 1) {
                    userWs.send(JSON.stringify({ type: "rideRejected", driverId: data.driverId }));
                }
            }

            // When driver updates ride status
            if (data.type === "rideStatusUpdate" && data.role === "driver") {
                const userWs = userSockets.get(data.rideData.user.id);
                const statusMessageMap = {
                    Booked: "Your ride has been booked!",
                    Processing: "Your driver is on the way to pick you up!",
                    Arrived: "Your driver is arrived on pickup location!",
                    Ongoing: "Your ride has started! Have a safe journey.",
                    Reached: "Your ride has reached destination!",
                    Completed: "Your ride has been completed! Thank you.",
                };
                if (userWs?.readyState === 1) {
                    userWs.send(
                        JSON.stringify({
                            type: "rideStatusUpdate",
                            rideId: data.rideData.id,
                            status: data.status,
                            message: statusMessageMap[data.status] || "Ride status updated",

                        })
                    );
                }
            }
            if (data.type === "rideStatusUpdate" && data.role === "user") {
                const driverWs = driverSockets.get(data.rideData.driver.id);
                if (driverWs?.readyState === 1) {
                    driverWs.send(
                        JSON.stringify({
                            type: "rideStatusUpdate",
                            rideId: data.rideData.id,
                            status: data.status
                        })
                    );
                }
            }


            if (data.type === "requestDriver" && data.role === "user") {
                const driverId = data.driverId;
                const driverData = drivers[driverId];
                const userWs = userSockets.get(data.userId);
                console.log(driverData)
                if (userWs?.readyState === 1) {

                    if (driverData) {
                        userWs.send(JSON.stringify({
                            type: "driverLocation",
                            drivers: [{
                                id: driverId,
                                current: driverData.current,
                                heading: driverData.heading,
                                previous: driverData.previous,
                            }],
                        }));
                    } else {
                        userWs.send(JSON.stringify({
                            type: "driverLocation",
                            drivers: [],
                            message: "Driver not found",
                        }));
                    }
                }
            }




        } catch (error) {
            console.log("Failed to parse WebSocket message:", error);
        }
    });
});

function broadcastDriverLocation(driverId, driverData) {
    const payload = JSON.stringify({
        type: "driverLocationUpdate",
        drivers: [
            {
                id: driverId,
                current: driverData.current,
                previous: driverData.previous,
                heading: driverData.heading,
            },
        ],
    });

    users.forEach((user) => {
        if (user.readyState === 1) user.send(payload);
    });
}

function broadcastToAdmins(driverId, driverData) {
    const payload = JSON.stringify({
        type: "driverLocationUpdate",
        drivers: [
            {
                id: driverId,
                current: driverData.current,
                heading: driverData.heading,
            },
        ],
    });

    adminSockets.forEach((admin) => {
        if (admin.readyState === 1) admin.send(payload);
    });
}

function calculateHeading(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * (Math.PI / 180);
    const toDeg = (rad) => rad * (180 / Math.PI);

    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);

    return ((toDeg(Math.atan2(y, x)) + 360) % 360);
}

function findNearbyDrivers(userLat, userLon) {
    return Object.entries(drivers)
        .filter(([id, driver]) => {
            const curr = driver?.current;
            if (!curr) return false;

            // ❗ Prevent geolib crash if driver location is null
            if (
                curr.latitude === null || curr.longitude === null ||
                typeof curr.latitude !== "number" ||
                typeof curr.longitude !== "number"
            ) {
                return false; // ignore this driver for distance filter
            }


            const distance = getDistance(
                { latitude: userLat, longitude: userLon },
                curr
            );
            return distance <= 10000;
        })
        .map(([id, driver]) => ({
            id,
            current: driver.current,
            heading: driver.heading ?? 0,
            previous: driver.previous,
        }));
}

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Socket API is working",
    });
});

// ✅ Start ONE server for both HTTP + WS
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});