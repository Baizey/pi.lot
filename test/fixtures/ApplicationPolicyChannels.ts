import {NetworkApplicationProtocol} from "../../src/policy/network/NetworkProtocol.js";
import {PolicyAccessType, PolicyArea} from "../../src/policy/types.js";

/** Additive channel vocabulary: independent expectations shared by integration tests. */
export const APPLICATION_POLICY_CHANNELS = [
    [NetworkApplicationProtocol.ADB, PolicyAccessType.ADB_ACCESS, PolicyArea.web_adb],
    [NetworkApplicationProtocol.POSTGRES, PolicyAccessType.POSTGRES_ACCESS, PolicyArea.web_postgres],
    [NetworkApplicationProtocol.MYSQL, PolicyAccessType.MYSQL_ACCESS, PolicyArea.web_mysql],
    [NetworkApplicationProtocol.REDIS, PolicyAccessType.REDIS_ACCESS, PolicyArea.web_redis],
    [NetworkApplicationProtocol.MONGODB, PolicyAccessType.MONGODB_ACCESS, PolicyArea.web_mongodb],
    [NetworkApplicationProtocol.MQTT, PolicyAccessType.MQTT_ACCESS, PolicyArea.web_mqtt],
    [NetworkApplicationProtocol.AMQP, PolicyAccessType.AMQP_ACCESS, PolicyArea.web_amqp],
    [NetworkApplicationProtocol.KAFKA, PolicyAccessType.KAFKA_ACCESS, PolicyArea.web_kafka],
    [NetworkApplicationProtocol.NATS, PolicyAccessType.NATS_ACCESS, PolicyArea.web_nats],
    [NetworkApplicationProtocol.FTP, PolicyAccessType.FTP_ACCESS, PolicyArea.web_ftp],
    [NetworkApplicationProtocol.SMB, PolicyAccessType.SMB_ACCESS, PolicyArea.web_smb],
    [NetworkApplicationProtocol.NFS, PolicyAccessType.NFS_ACCESS, PolicyArea.web_nfs],
    [NetworkApplicationProtocol.LDAP, PolicyAccessType.LDAP_ACCESS, PolicyArea.web_ldap],
    [NetworkApplicationProtocol.IMAP, PolicyAccessType.IMAP_ACCESS, PolicyArea.web_imap],
    [NetworkApplicationProtocol.POP3, PolicyAccessType.POP3_ACCESS, PolicyArea.web_pop3],
] as const;
