package com.secmynet.mobile

data class User(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    val createdAt: String? = null
)

data class LocationRow(
    val id: String,
    val name: String,
    val city: String,
    val adminId: String,
    val createdAt: String? = null,
    val devicesCount: Int = 0
)

data class DeviceRow(
    val id: String,
    val name: String,
    val wifiName: String,
    val status: String,
    val location: LocationRow? = null,
    val allowedUserIds: List<String> = emptyList(),
    val createdBy: String = "",
    val createdAt: String? = null
)

data class DashboardStats(
    val totalUsers: Int,
    val adminUsers: Int,
    val totalLocations: Int,
    val totalDevices: Int,
    val activeConnections: Int
)

data class ConnectionRow(
    val id: String,
    val deviceId: String,
    val userId: String,
    val userName: String,
    val userEmail: String,
    val deviceName: String,
    val status: String,
    val dataUsedMb: Double,
    val locationName: String? = null,
    val connectedAt: String? = null,
    val disconnectedAt: String? = null
)

data class DashboardData(
    val user: User? = null,
    val stats: DashboardStats,
    val devices: List<DeviceRow> = emptyList(),
    val locations: List<LocationRow> = emptyList(),
    val users: List<User> = emptyList(),
    val connections: List<ConnectionRow>
)
