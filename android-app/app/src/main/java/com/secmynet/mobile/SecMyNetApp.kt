package com.secmynet.mobile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

@Composable
fun SecMyNetApp() {
    val apiClient = remember { ApiClient() }
    var email by remember { mutableStateOf("admin@secmynet.com") }
    var password by remember { mutableStateOf("Admin@123") }
    var name by remember { mutableStateOf("SecMyNet Admin") }
    var token by remember { mutableStateOf("") }
    var dashboard by remember { mutableStateOf<DashboardData?>(null) }
    var status by remember { mutableStateOf("Ready") }
    var userIdInput by remember { mutableStateOf("") }
    var usageInput by remember { mutableStateOf("25") }
    val scope = rememberCoroutineScope()

    fun refreshDashboard() {
        scope.launch {
            try {
                val response = withContext(Dispatchers.IO) { apiClient.dashboard(token) }
                dashboard = parseDashboard(response)
                status = "Dashboard loaded for ${dashboard?.user?.role ?: "member"}"
            } catch (error: Exception) {
                status = error.message ?: "Unable to load dashboard"
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("SecMyNet Mobile Admin", style = MaterialTheme.typography.headlineMedium)
        Text(status)

        Card {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth()
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = {
                        scope.launch {
                            try {
                                val response = withContext(Dispatchers.IO) { apiClient.register(name, email, password) }
                                token = response.getString("token")
                                status = "Registered successfully"
                                refreshDashboard()
                            } catch (error: Exception) {
                                status = error.message ?: "Registration failed"
                            }
                        }
                    }) {
                        Text("Register")
                    }

                    Button(onClick = {
                        scope.launch {
                            try {
                                val response = withContext(Dispatchers.IO) { apiClient.login(email, password) }
                                token = response.getString("token")
                                status = "Logged in successfully"
                                refreshDashboard()
                            } catch (error: Exception) {
                                status = error.message ?: "Login failed"
                            }
                        }
                    }) {
                        Text("Login")
                    }
                }
            }
        }

        if (dashboard != null) {
            Card {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    Text("Dashboard Overview", style = MaterialTheme.typography.titleLarge)
                    Text("Role: ${dashboard!!.user?.role ?: "unknown"}")
                    Text("Users: ${dashboard!!.stats.totalUsers}")
                    Text("Locations: ${dashboard!!.stats.totalLocations}")
                    Text("Devices: ${dashboard!!.stats.totalDevices}")
                    Text("Active Connections: ${dashboard!!.stats.activeConnections}")

                    Spacer(modifier = Modifier.height(6.dp))
                    Text("Device Access Controls", style = MaterialTheme.typography.titleMedium)
                    OutlinedTextField(
                        value = userIdInput,
                        onValueChange = { userIdInput = it },
                        label = { Text("User ID") },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = usageInput,
                        onValueChange = { usageInput = it },
                        label = { Text("Usage MB") },
                        modifier = Modifier.fillMaxWidth()
                    )

                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(dashboard!!.devices) { device ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color(0xFFFAFAFA))
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    Text("${device.name} • ${device.wifiName}")
                                    Text("Status: ${device.status}")
                                    Text("Location: ${device.location?.name ?: "Unknown"}")
                                    Text("Allowed IDs: ${device.allowedUserIds.joinToString(", ")}")

                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Button(onClick = {
                                            scope.launch {
                                                try {
                                                    withContext(Dispatchers.IO) {
                                                        apiClient.allowUser(token, device.id, userIdInput)
                                                    }
                                                    status = "User allowed on ${device.name}"
                                                    refreshDashboard()
                                                } catch (error: Exception) {
                                                    status = error.message ?: "Allow action failed"
                                                }
                                            }
                                        }) {
                                            Text("Allow")
                                        }

                                        Button(onClick = {
                                            scope.launch {
                                                try {
                                                    withContext(Dispatchers.IO) {
                                                        apiClient.disallowUser(token, device.id, userIdInput)
                                                    }
                                                    status = "User removed from ${device.name}"
                                                    refreshDashboard()
                                                } catch (error: Exception) {
                                                    status = error.message ?: "Disallow action failed"
                                                }
                                            }
                                        }) {
                                            Text("Disallow")
                                        }
                                    }
                                }
                            }
                        }

                        items(dashboard!!.connections) { connection ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .background(Color(0xFFF1F5F9))
                            ) {
                                Column(
                                    modifier = Modifier.padding(12.dp),
                                    verticalArrangement = Arrangement.spacedBy(6.dp)
                                ) {
                                    Text("${connection.userName} -> ${connection.deviceName} [${connection.status}]")
                                    Text("Usage: ${connection.dataUsedMb} MB")
                                    Text("Location: ${connection.locationName ?: "N/A"}")

                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Button(onClick = {
                                            scope.launch {
                                                try {
                                                    withContext(Dispatchers.IO) {
                                                        apiClient.disconnectUser(token, connection.deviceId, connection.userId)
                                                    }
                                                    status = "Disconnected ${connection.userName}"
                                                    refreshDashboard()
                                                } catch (error: Exception) {
                                                    status = error.message ?: "Disconnect failed"
                                                }
                                            }
                                        }) {
                                            Text("Disconnect")
                                        }

                                        Button(onClick = {
                                            scope.launch {
                                                try {
                                                    withContext(Dispatchers.IO) {
                                                        apiClient.updateUsage(token, connection.id, usageInput.toDouble())
                                                    }
                                                    status = "Usage updated for ${connection.userName}"
                                                    refreshDashboard()
                                                } catch (error: Exception) {
                                                    status = error.message ?: "Usage update failed"
                                                }
                                            }
                                        }) {
                                            Text("Update Usage")
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun parseDashboard(response: JSONObject): DashboardData {
    val user = response.optJSONObject("user")?.let {
        User(
            id = it.optString("id"),
            name = it.optString("name"),
            email = it.optString("email"),
            role = it.optString("role")
        )
    }

    val statsObject = response.getJSONObject("stats")
    val devicesArray = response.optJSONArray("devices") ?: JSONArray()
    val locationsArray = response.optJSONArray("locations") ?: JSONArray()
    val usersArray = response.optJSONArray("users") ?: JSONArray()
    val connectionsArray = response.optJSONArray("connections") ?: JSONArray()

    val locations = mutableListOf<LocationRow>()
    for (index in 0 until locationsArray.length()) {
        val item = locationsArray.getJSONObject(index)
        locations.add(
            LocationRow(
                id = item.optString("id"),
                name = item.optString("name"),
                city = item.optString("city"),
                adminId = item.optString("admin_id"),
                createdAt = item.optString("created_at"),
                devicesCount = item.optInt("devicesCount")
            )
        )
    }

    val devices = mutableListOf<DeviceRow>()
    for (index in 0 until devicesArray.length()) {
        val item = devicesArray.getJSONObject(index)
        val locationObject = item.optJSONObject("location")
        val allowedUserIds = mutableListOf<String>()
        val allowedArray = item.optJSONArray("allowedUserIds")
        if (allowedArray != null) {
            for (allowedIndex in 0 until allowedArray.length()) {
                allowedUserIds += allowedArray.optString(allowedIndex)
            }
        }

        devices.add(
            DeviceRow(
                id = item.optString("id"),
                name = item.optString("name"),
                wifiName = item.optString("wifi_name"),
                status = item.optString("status"),
                location = if (locationObject == null) null else LocationRow(
                    id = locationObject.optString("id"),
                    name = locationObject.optString("name"),
                    city = locationObject.optString("city"),
                    adminId = locationObject.optString("admin_id")
                ),
                allowedUserIds = allowedUserIds,
                createdBy = item.optString("created_by"),
                createdAt = item.optString("created_at")
            )
        )
    }

    val users = mutableListOf<User>()
    for (index in 0 until usersArray.length()) {
        val item = usersArray.getJSONObject(index)
        users.add(
            User(
                id = item.optString("id"),
                name = item.optString("name"),
                email = item.optString("email"),
                role = item.optString("role")
            )
        )
    }

    val connections = mutableListOf<ConnectionRow>()
    for (index in 0 until connectionsArray.length()) {
        val item = connectionsArray.getJSONObject(index)
        connections.add(
            ConnectionRow(
                id = item.optString("id"),
                deviceId = item.optString("deviceId") ?: item.optString("device_id") ?: "",
                userId = item.optString("userId") ?: item.optString("user_id") ?: "",
                userName = item.optString("userName") ?: item.optString("user_name") ?: "Unknown",
                userEmail = item.optString("userEmail") ?: item.optString("user_email") ?: "Unknown",
                deviceName = item.optString("deviceName") ?: item.optString("device_name") ?: "Unknown",
                status = item.optString("status"),
                dataUsedMb = item.optDouble("dataUsedMb", item.optDouble("data_used_mb")),
                locationName = item.optString("locationName") ?: item.optString("location_name") ?: null,
                connectedAt = item.optString("connectedAt") ?: item.optString("connected_at") ?: null,
                disconnectedAt = item.optString("disconnectedAt") ?: item.optString("disconnected_at") ?: null
            )
        )
    }

    return DashboardData(
        user = user,
        stats = DashboardStats(
            totalUsers = statsObject.optInt("totalUsers"),
            adminUsers = statsObject.optInt("adminUsers"),
            totalLocations = statsObject.optInt("totalLocations"),
            totalDevices = statsObject.optInt("totalDevices"),
            activeConnections = statsObject.optInt("activeConnections")
        ),
        devices = devices,
        locations = locations,
        users = users,
        connections = connections
    )
}
