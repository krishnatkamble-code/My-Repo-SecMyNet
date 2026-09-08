package com.secmynet.mobile

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

class ApiClient(private val baseUrl: String = BuildConfig.API_BASE_URL) {
    fun login(email: String, password: String): JSONObject {
        return postJson("/api/login", mapOf("email" to email, "password" to password))
    }

    fun register(name: String, email: String, password: String): JSONObject {
        return postJson("/api/register", mapOf("name" to name, "email" to email, "password" to password))
    }

    fun profile(token: String): JSONObject {
        return getJson("/api/profile", token)
    }

    fun dashboard(token: String): JSONObject {
        val profile = profile(token)
        val role = profile.getJSONObject("user").optString("role", "user")
        return if (role == "admin" || role == "super_admin") {
            getJson("/api/dashboard", token)
        } else {
            getJson("/api/user-dashboard", token)
        }
    }

    fun allowUser(token: String, deviceId: String, userId: String): JSONObject {
        return postJson(
            "/api/devices/$deviceId/allow-user",
            mapOf("userId" to userId),
            token
        )
    }

    fun disallowUser(token: String, deviceId: String, userId: String): JSONObject {
        return postJson(
            "/api/devices/$deviceId/disallow-user",
            mapOf("userId" to userId),
            token
        )
    }

    fun disconnectUser(token: String, deviceId: String, userId: String): JSONObject {
        return postJson(
            "/api/devices/$deviceId/disconnect-user",
            mapOf("userId" to userId),
            token
        )
    }

    fun updateUsage(token: String, connectionId: String, dataUsedMb: Double): JSONObject {
        return postJson(
            "/api/connections/$connectionId/usage",
            mapOf("dataUsedMb" to dataUsedMb.toString()),
            token
        )
    }

    private fun postJson(path: String, payload: Map<String, String>, token: String? = null): JSONObject {
        val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        if (token != null) {
            connection.setRequestProperty("Authorization", "Bearer $token")
        }

        val body = JSONObject(payload).toString()
        val output = OutputStreamWriter(connection.outputStream, StandardCharsets.UTF_8)
        output.write(body)
        output.flush()
        output.close()

        return readResponse(connection)
    }

    private fun getJson(path: String, token: String): JSONObject {
        val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.setRequestProperty("Authorization", "Bearer $token")
        connection.connectTimeout = 15000
        connection.readTimeout = 15000

        return readResponse(connection)
    }

    private fun readResponse(connection: HttpURLConnection): JSONObject {
        val responseCode = connection.responseCode
        val stream = if (responseCode in 200..299) connection.inputStream else connection.errorStream
        val reader = BufferedReader(InputStreamReader(stream, StandardCharsets.UTF_8))
        val content = reader.readText()
        reader.close()

        if (responseCode !in 200..299) {
            Log.e("SecMyNetApi", "HTTP $responseCode -> $content")
            throw IllegalStateException(content)
        }

        return JSONObject(content)
    }
}
