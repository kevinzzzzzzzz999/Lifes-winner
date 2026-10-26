import Foundation
import UserNotifications
import CryptoKit

struct WorkNotificationSpec: Codable, Equatable, Sendable {
    let id: String
    let fireAt: String
    let title: String
    let body: String
    var fingerprint: String {
        let e=JSONEncoder();e.outputFormatting=[.sortedKeys]
        return SHA256.hash(data:(try? e.encode(self)) ?? Data()).map{String(format:"%02x",$0)}.joined()
    }
}
struct WorkNotificationStatus: Codable, Equatable, Sendable {
    let authorization: String
    let pending: Int
    let limited: Bool
}
struct WorkNotificationReceipt: Sendable { let identifier: String; let fireAt: String?; var fingerprint:String? = nil }
protocol WorkNotificationClient: Sendable {
    func authorization() async -> String
    func request() async throws -> String
    func pending() async -> [WorkNotificationReceipt]
    func delivered() async -> [WorkNotificationReceipt]
    func remove(_ identifiers: [String]) async
    func add(_ spec: WorkNotificationSpec, identifier: String, date: Date) async throws
}
struct SystemWorkNotificationClient: WorkNotificationClient {
    private var available: Bool {
        #if os(macOS)
        Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil
        #else
        true
        #endif
    }
    func authorization() async -> String {
        guard available else { return "unsupported" }
        let value=await UNUserNotificationCenter.current().notificationSettings()
        switch value.authorizationStatus {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional,.ephemeral: return "provisional"
        @unknown default: return "unsupported"
        }
    }
    func request() async throws -> String {
        guard available else { return "unsupported" }
        if await authorization()=="notDetermined" { _ = try await UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound,.badge]) }
        return await authorization()
    }
    func pending() async -> [WorkNotificationReceipt] {
        guard available else{return []}
        return await UNUserNotificationCenter.current().pendingNotificationRequests().map { .init(identifier:$0.identifier,fireAt:$0.content.userInfo["fireAt"] as? String,fingerprint:$0.content.userInfo["specFingerprint"] as? String) }
    }
    func delivered() async -> [WorkNotificationReceipt] {
        guard available else{return []}
        return await UNUserNotificationCenter.current().deliveredNotifications().map { .init(identifier:$0.request.identifier,fireAt:$0.request.content.userInfo["fireAt"] as? String) }
    }
    func remove(_ identifiers:[String]) async {
        guard available,!identifiers.isEmpty else{return}
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers:identifiers)
    }
    func add(_ spec:WorkNotificationSpec,identifier:String,date:Date) async throws {
        guard available else{throw WorkNotificationError.unsupported}
        let content=UNMutableNotificationContent();content.title=spec.title;content.body=spec.body;content.sound = .default
        content.userInfo=["workItemID":spec.id,"fireAt":spec.fireAt,"specFingerprint":spec.fingerprint]
        var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(secondsFromGMT:0)!
        var components=calendar.dateComponents([.year,.month,.day,.hour,.minute,.second],from:date)
        components.calendar=calendar;components.timeZone=calendar.timeZone
        let request=UNNotificationRequest(identifier:identifier,content:content,trigger:UNCalendarNotificationTrigger(dateMatching:components,repeats:false))
        try await UNUserNotificationCenter.current().add(request)
    }
}
enum WorkNotificationError: LocalizedError {
    case invalid, unsupported, capacity
    var errorDescription:String? {
        switch self {
        case .invalid: String(localized:"提醒内容或时间无效，未更改系统安排。")
        case .capacity: String(localized:"系统提醒容量不足；Work 内容已保存，请刷新核对已安排数量。")
        case .unsupported: String(localized:"当前运行方式不支持系统通知，请从正式应用打开。")
        }
    }
}
actor WorkNotifications {
    static let shared=WorkNotifications()
    static let prefix="lifeswinner.work."
    private let client:any WorkNotificationClient
    private let clock:@Sendable ()->Date
    private var limited=false
    private var working=false
    private var waiters:[CheckedContinuation<Void,Never>]=[]
    init(client:any WorkNotificationClient=SystemWorkNotificationClient(),clock:@escaping @Sendable ()->Date={Date()}) {self.client=client;self.clock=clock}
    private func acquire() async {
        if !working {working=true;return}
        await withCheckedContinuation{waiters.append($0)}
    }
    private func release() {if waiters.isEmpty{working=false}else{waiters.removeFirst().resume()}}
    func status() async -> WorkNotificationStatus {
        let authorization=await client.authorization(),pending=await client.pending().filter{$0.identifier.hasPrefix(Self.prefix)}.count
        return .init(authorization:authorization,pending:pending,limited:limited)
    }
    func request() async throws -> WorkNotificationStatus {
        await acquire();defer{release()};try Task.checkCancellation()
        _ = try await client.request();return await status()
    }
    func replace(specs:[WorkNotificationSpec]) async throws -> WorkNotificationStatus {
        await acquire();defer{release()};try Task.checkCancellation()
        guard specs.count<=5000,Set(specs.map{$0.id.lowercased()}).count==specs.count else{throw WorkNotificationError.invalid}
        let formatter=ISO8601DateFormatter()
        func instant(_ value:String)->Date? {
            guard value.range(of:#"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"#,options:.regularExpression) != nil else{return nil}
            formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
            if let date=formatter.date(from:value),formatter.string(from:date).prefix(19)==value.prefix(19),!value.hasPrefix("0000"){return date}
            formatter.formatOptions=[.withInternetDateTime]
            guard let date=formatter.date(from:value),formatter.string(from:date).prefix(19)==value.prefix(19),!value.hasPrefix("0000") else{return nil}
            return date
        }
        var valid:[(WorkNotificationSpec,Date)]=[]
        for spec in specs {
            guard UUID(uuidString:spec.id) != nil,let date=instant(spec.fireAt),!spec.title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                  spec.title.utf16.count<=4000,spec.body.utf16.count<=8000,!spec.title.contains("\0"),!spec.body.contains("\0") else{throw WorkNotificationError.invalid}
            if date>clock(){valid.append((spec,date))}
        }
        valid.sort{ $0.1 == $1.1 ? $0.0.id<$1.0.id:$0.1<$1.1 }
        let delivered=await client.delivered()
        valid.removeAll{spec,date in delivered.contains{$0.identifier==Self.prefix+spec.id.lowercased() && ($0.fireAt==nil || $0.fireAt.flatMap(instant)==date)}}
        let pending=await client.pending()
        let foreign=pending.filter{!$0.identifier.hasPrefix(Self.prefix)}.count
        let capacity=min(60,max(0,64-foreign))
        limited=valid.count>capacity
        let chosen=Array(valid.prefix(capacity))
        let authorization=await client.authorization()
        let allowed=authorization=="authorized" || authorization=="provisional"
        let identifiers=allowed ? Set(chosen.map{Self.prefix+$0.0.id.lowercased()}):Set<String>()
        // Never leave an obsolete time queued while permission is denied, and
        // never cancel unrelated app/module requests.
        await client.remove(pending.filter{$0.identifier.hasPrefix(Self.prefix) && !identifiers.contains($0.identifier)}.map(\.identifier))
        if allowed {
            for (spec,date) in chosen {
                try Task.checkCancellation()
                let id=Self.prefix+spec.id.lowercased()
                // Unchanged pending requests need no replacement or extra alert.
                if pending.contains(where:{$0.identifier==id && $0.fireAt==spec.fireAt && $0.fingerprint==spec.fingerprint}){continue}
                try await client.add(spec,identifier:id,date:date)
            }
            let actual=Set(await client.pending().map(\.identifier))
            guard identifiers.isSubset(of:actual) else{throw WorkNotificationError.capacity}
        }
        return await status()
    }
}

/// Installed once only when no existing app delegate owns notifications.
@MainActor final class WorkNotificationOpenRouter {
    static let shared=WorkNotificationOpenRouter()
    static let changed=Notification.Name("InkSpace.Work.NotificationOpen")
    private var pending:UUID?
    func enqueue(_ id:UUID) {pending=id;NotificationCenter.default.post(name:Self.changed,object:nil)}
    func claim()->UUID? {defer{pending=nil};return pending}
}
final class WorkNotificationForegroundDelegate:NSObject,UNUserNotificationCenterDelegate,@unchecked Sendable {
    private static let retained=WorkNotificationForegroundDelegate()
    @MainActor static func installIfAbsent() {
        #if os(macOS)
        guard Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier != nil else{return}
        #endif
        let center=UNUserNotificationCenter.current()
        if center.delegate==nil {center.delegate=retained}
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification) async -> UNNotificationPresentationOptions {
        notification.request.identifier.hasPrefix(WorkNotifications.prefix) ? [.banner,.list,.sound]:[]
    }
    func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse) async {
        guard response.notification.request.identifier.hasPrefix(WorkNotifications.prefix),
              let raw=response.notification.request.content.userInfo["workItemID"] as? String,let id=UUID(uuidString:raw) else{return}
        await MainActor.run{WorkNotificationOpenRouter.shared.enqueue(id)}
    }
}
