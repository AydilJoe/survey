import Foundation
import Capacitor
import CloudKit

/// iCloud backup transport for Duitful, on CloudKit.
///
/// Stores ONE record in the user's private CloudKit database, in Duitful's
/// container (iCloud.com.aydiljoe.duitful): record type `Backup`, record
/// name `duitful-backup`, with the backup as an Asset in `payload`. The
/// payload is the same AES-GCM record the web layer already writes to
/// localStorage and to Google Drive, wrapped with a little metadata. Swift
/// never sees plaintext and never parses it. All it does is move a string
/// in and out of iCloud.
///
/// Why CloudKit and not an iCloud Drive file: the first version used iCloud
/// Documents, which needs iCloud Drive switched on. On a real iPhone with
/// iCloud Drive off, the container never opened and the card said iCloud
/// was unavailable. CloudKit's private database only needs the user to be
/// signed in to iCloud.
///
/// Production CloudKit refuses record types that aren't in its deployed
/// schema, so `Backup` (one Asset field, `payload`) must exist in the
/// container's Production schema. See "iCloud backup on iOS" in
/// IOS_BUILD.md. Until it does, read returns no backup and write fails
/// with code SCHEMA.
@objc(DuitfulICloudPlugin)
public class DuitfulICloudPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DuitfulICloudPlugin"
    public let jsName = "DuitfulICloud"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
    ]

    private static let containerId = "iCloud.com.aydiljoe.duitful"
    private static let recordType = "Backup"
    private static let recordName = "duitful-backup"
    private static let payloadKey = "payload"

    private lazy var container = CKContainer(identifier: Self.containerId)
    private var database: CKDatabase { container.privateCloudDatabase }
    private var recordID: CKRecord.ID { CKRecord.ID(recordName: Self.recordName) }

    /// `reason` names what to change when iCloud can't be used:
    ///   "no-account"              — not signed in to iCloud
    ///   "restricted"              — Screen Time / MDM blocks iCloud
    ///   "temporarily-unavailable" — iCloud needs attention in Settings
    ///   "error"                   — anything else (message attached)
    @objc func status(_ call: CAPPluginCall) {
        container.accountStatus { status, error in
            switch status {
            case .available:
                call.resolve(["available": true, "reason": ""])
            case .noAccount:
                call.resolve(["available": false, "reason": "no-account"])
            case .restricted:
                call.resolve(["available": false, "reason": "restricted"])
            case .temporarilyUnavailable:
                call.resolve(["available": false, "reason": "temporarily-unavailable"])
            default:
                call.resolve([
                    "available": false,
                    "reason": "error",
                    "message": error?.localizedDescription ?? "Couldn't determine the iCloud account",
                ])
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        guard let text = call.getString("data"), let data = text.data(using: .utf8) else {
            call.reject("Nothing to save", "BAD_INPUT")
            return
        }
        // CKAsset uploads from a file. A temp file per write, removed when
        // CloudKit is done with it.
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("duitful-backup-\(UUID().uuidString).json")
        do {
            try data.write(to: tmp, options: .atomic)
        } catch {
            call.reject("Couldn't prepare the backup: \(error.localizedDescription)", "WRITE_FAILED")
            return
        }
        let record = CKRecord(recordType: Self.recordType, recordID: recordID)
        record[Self.payloadKey] = CKAsset(fileURL: tmp)

        // .allKeys overwrites whatever the server holds without needing its
        // change tag: last write wins, which is the backup's whole policy.
        let op = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
        op.savePolicy = .allKeys
        op.qualityOfService = .userInitiated
        op.modifyRecordsResultBlock = { result in
            try? FileManager.default.removeItem(at: tmp)
            switch result {
            case .success:
                call.resolve(["ok": true])
            case .failure(let error):
                let (message, code) = Self.describe(error, verb: "save to")
                call.reject(message, code)
            }
        }
        database.add(op)
    }

    /// Resolves `{ data: String }`, or `{ data: null }` when there is no backup.
    @objc func read(_ call: CAPPluginCall) {
        database.fetch(withRecordID: recordID) { record, error in
            if let ck = error as? CKError, ck.code == .unknownItem {
                call.resolve(["data": NSNull()])
                return
            }
            if let error = error {
                let (message, code) = Self.describe(error, verb: "read from")
                call.reject(message, code)
                return
            }
            guard let asset = record?[Self.payloadKey] as? CKAsset,
                  let url = asset.fileURL,
                  let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8) else {
                call.reject("The iCloud backup is damaged", "READ_FAILED")
                return
            }
            call.resolve(["data": text])
        }
    }

    /// A sentence a person can act on, and a code the web layer can branch on.
    private static func describe(_ error: Error, verb: String) -> (String, String) {
        guard let ck = error as? CKError else {
            return ("Couldn't \(verb) iCloud: \(error.localizedDescription)", "FAILED")
        }
        // A partial failure wraps the per-record error; that one says why.
        if ck.code == .partialFailure,
           let inner = ck.partialErrorsByItemID?.values.first {
            return describe(inner, verb: verb)
        }
        switch ck.code {
        case .notAuthenticated:
            return ("Sign in to iCloud in the Settings app first.", "NO_ACCOUNT")
        case .networkUnavailable, .networkFailure, .serviceUnavailable, .requestRateLimited, .zoneBusy:
            return ("iCloud can't be reached right now. It will try again on your next change.", "OFFLINE")
        case .quotaExceeded:
            return ("Your iCloud storage is full.", "QUOTA")
        case .serverRejectedRequest, .invalidArguments, .unknownItem:
            // The usual cause in Production: the Backup record type was
            // never deployed to the container's schema.
            return ("iCloud refused the backup (\(ck.code.rawValue)): \(ck.localizedDescription)", "SCHEMA")
        default:
            return ("Couldn't \(verb) iCloud (\(ck.code.rawValue)): \(ck.localizedDescription)", "FAILED")
        }
    }
}
