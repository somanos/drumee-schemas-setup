const {
  toArray, Mariadb, Logger, Remit, Attr, Constants,
  uniqueId
} = require("@drumee/server-essentials");
const diskSpace = require("check-disk-space").default;

const PADDING = ''.padStart(process.stdout.columns, ' ') + '\r';

const {
  ID_NOBODY,
  FORGOT_PASSWORD,
} = Constants;
const { join } = require("path");
const { existsSync } = require("fs");
const domain_id = 1;
const { getConfigs } = require('./utils');
const {
  domain_desc,
  domain,
  credential_dir,
  data_dir,
  media_vhost,
  media_hubname,
  wallpapers_path
} = getConfigs();

const { ADMIN_EMAIL, ACME_EMAIL_ACCOUNT } = process.env;
const { DOM_OWNER } = Remit;
const EMAIL_CREDENTIAL = join(credential_dir, "email.json");
const { readFileSync } = require("jsonfile");

const Drumate = require("./drumate");
global.verbosity = 4;
global.LOG_LEVEL = global.verbosity;


class Organization extends Logger {
  initialize(opt = {}) {
    this.yp = new Mariadb({ name: "yp" });
  }

  /**
   * 
   */
  _email() {
    let r = [
      `REPLACE INTO mailserver.domains SELECT ${domain_id}, '${domain}'`,
      `REPLACE INTO mailserver.aliases SELECT null, ${domain_id}, 'butler@${domain}', 'butler@${domain}'`,
    ];
    if (!existsSync(EMAIL_CREDENTIAL)) {
      return r
    }

    const { auth } = readFileSync(EMAIL_CREDENTIAL);
    if (auth && auth.pass) {
      r.push(`CALL mailserver.create_or_update_user('butler', ${domain_id}, "${auth.pass}")`);
    }
    return r;
  }


  /**
   * 
   */
  _vhost() {
    const hosts = [
      'ns1',
      'ns2',
      'jit',
      'www',
      'smtp',
      '_acme-challenge',
      '_domainkey'
    ];
    let r = []
    for (let ident of hosts) {
      r.push(`INSERT IGNORE INTO vhost SELECT NULL, '${ident}.${domain}', uniqueId(), ${domain_id}`)
    }
    return r;
  }

  /**
   * 
   */
  async _sysconf() {
    let guest_id = await this.yp.await_func("uniqueId");
    let p_conf = 'REPLACE INTO sys_conf SELECT';
    let p_domain = 'REPLACE INTO domain SELECT';
    let p_org = 'REPLACE INTO organisation SELECT';
    let p_settings = `REPLACE INTO settings SELECT 1, 'localhost', 'localhost', `;
    const mfs = join(data_dir, "mfs");
    const icon = '/-/images/logo/desk.jpg';
    const drumate_dir = join(mfs, "drumate");
    const hub_dir = join(mfs, "hub");
    const wallpaper = {
      host: media_vhost,
      nid: wallpapers_path,
    };
    const settings = JSON.stringify({
      wallpaper,
      cache_control: "no-cache",
      default_privilege: 3,
    });
    const metadata = JSON.stringify({
      name: domain_desc,
      ident: "drumee",
      domain_id,
      isOrganization: 1
    });
    return [
      `${p_conf} 'guest_id', '${guest_id}'`,
      `${p_conf} 'public_id', '${guest_id}'`,
      `${p_conf} 'nobody_id', '${ID_NOBODY}'`,
      `${p_conf} 'domain_name', '${domain}'`,
      `${p_conf} 'mfs_root', '${mfs}'`,
      `${p_conf} 'sys_root', '${mfs}'`,
      `${p_conf} 'sys_root_drumate', '${mfs}/drumate'`,
      `${p_conf} 'sys_root_user', '${mfs}/user'`,
      `${p_conf} 'usage_type', 'private'`,
      `${p_conf} 'quota', '{"watermark":"Infinity"}'`,
      `${p_conf} 'icon', '${icon}'`,
      `${p_conf} 'entry_host', '${domain}'`,
      `${p_conf} 'support_domain', 0`,
      `${p_conf} 'wallpaper', '${JSON.stringify(wallpaper)}'`,
      `${p_domain} 1, '${domain}'`,

      `${p_org} 1, uniqueId(), 1, '${domain_desc}', '${domain}', 'drumee', 1, 'all', 'all', 0, 0, '*', '${metadata}'`,
      `${p_settings} '${mfs}', '${drumate_dir}', '${hub_dir}', '${icon}', '', '${settings}', '${domain}', '${domain}'`,
    ]
  }
  /**
   *
   * @returns
   */
  async populate() {

    let stm = await this._sysconf();
    let i = 0;
    let items = stm.concat(this._vhost(), this._email())
    for (let c of items) {
      i++;
      process.stdout.write(PADDING);
      process.stdout.write(`Updating system configuration(${i}/${items.length})\r`);
      await this.yp.await_query(c);
    }
    console.log('done!');
    return;
  }

  /***
   * 
   */
  async remove(id) {
    if (!id) {
      this.debug("AAA:94 -- require name or id");
      return []
    }
    let dom = await this.yp.await_query(`SELECT * FROM domain WHERE id=?`, id);
    let drumate = new Drumate({ yp: this.yp });
    let users = [];
    if (dom && dom.id) {
      this.debug("Removing", dom);
      users = await this.yp.await_query(`SELECT id, email FROM drumate WHERE domain_id=?`, dom.id);
      for (let peer of toArray(users)) {
        drumate.remove(peer);
        await this.yp.await_query(`DELETE FROM map_role WHERE uid=?`, peer.id);
        await this.yp.await_query(`DELETE FROM privilege WHERE uid=?`, peer.id);
        await this.yp.await_query(`DELETE FROM cookie WHERE uid=?`, peer.id);
        await this.yp.await_query(`DELETE FROM socket WHERE uid=?`, peer.id);
      }
      await this.yp.await_query(`DELETE FROM hub WHERE domain_id=?`, id);
      await this.yp.await_query(`DELETE FROM organisation WHERE domain_id=?`, id);
      await this.yp.await_query(`DELETE FROM domain WHERE id=?`, id);
      await this.yp.await_query(`DELETE FROM vhost WHERE dom_id=?`, id);
      await this.yp.await_query(`DELETE FROM map_role WHERE org_id=?`, id);
    }
    return users;
  }


  /**
   * 
   */
  async createSystemUser() {
    const { domain } = getConfigs();
    let email = `system@${domain}`;
    let username = email.split('@')[0];
    let firstname = "System", lastname = "User";

    let sql;
    let owner = new Drumate({ yp: this.yp });
    let uid = await this.yp.await_func("uniqueId");

    let res = await owner.create({
      domain,
      privilege: DOM_OWNER,
      firstname,
      lastname,
      username,
      email,
      uid
    });

    let media = await owner.createHub({
      domain,
      area: Attr.public,
      filename: "Media Center",
      owner_id: res.id,
      hubname: media_hubname,
      vhost: media_vhost,
      status: 'system'
    });

    let portalId = uniqueId();
    let portal = await owner.createHub({
      domain,
      area: Attr.public,
      hubname: portalId,
      filename: "Portal",
      owner_id: res.id,
      vhost: domain,
      status: 'system'
    });

    return { media, portal };
  }

  /**
  * 
  */
  async createAdmin(wp) {
    const { domain } = getConfigs();
    let email = ADMIN_EMAIL || ACME_EMAIL_ACCOUNT || `admin@${domain}`;
    let username = email.split('@')[0];
    let { firstname, lastname } = username.split(/[\.\,]/);

    if (!firstname) {
      firstname = "";
    }
    if (!lastname) {
      lastname = "";
    }
    let admin = new Drumate({ yp: this.yp });
    let uid = await this.yp.await_func("uniqueId");

    let res = await admin.create({
      domain,
      privilege: DOM_OWNER,
      firstname,
      lastname,
      username,
      email,
      uid
    });
    let { db_name } = res;
    await this.yp.await_proc(`${db_name}.join_hub`, wp.id);
    await this.yp.await_proc(`${db_name}.permission_grant`, wp.id, res.id, 0, 31, 'system', '');
    await this.yp.await_proc(`${wp.db_name}.permission_grant`, '*', res.id, 0, 31, 'system', '');

    await admin.createHub({
      domain,
      area: Attr.public,
      hubname: "public",
      filename: "My Website",
      owner_id: res.id
    });

    await admin.createHub({
      domain,
      area: Attr.private,
      hubname: uniqueId(),
      filename: "My Internal Sharebox",
      owner_id: res.id
    });

    await admin.createHub({
      domain,
      area: Attr.dmz,
      hubname: uniqueId(),
      filename: "My Extenal Sharebox",
      owner_id: res.id
    });

    let df = await diskSpace(data_dir);
    this.debug(`Checking disk space allocated to MFS ${data_dir}`);
    let { free } = df;
    free = free || 10000000;
    free = free * 0.75;
    let quota = {
      share_hub: 9999999,
      private_hub: 9999999,
      watermark: "Infinity",
      disk: free,
      desk_disk: free,
      hub_disk: free
    };

    await this.yp.await_proc("drumate_update_profile", res.id, { quota });

    const token = uniqueId();
    let name = [firstname, lastname].join(" ");
    await this.yp.await_proc(
      "token_generate_next",
      email,
      name,
      token,
      FORGOT_PASSWORD,
      res.id
    );
    res.reset_link = `https://${domain}/-/#/welcome/reset/${res.id}/${token}`;
    return { ...res, domain };
  }

  /**
   *
   */
  async createNobody() {
    let user = new Drumate({ yp: this.yp });
    let username = 'nobody';
    let res = await user.create({
      domain,
      privilege: 1,
      firstname: "",
      lastname: "",
      username,
      category: "system",
      email: `${username}@${domain}`,
      uid: ID_NOBODY
    });
    return res;
  }


  /**
   * 
   * @returns 
   */
  async createGuest() {
    let user = new Drumate({ yp: this.yp });
    let username = 'guest';
    let uid = await this.yp.await_func('get_sysconf', 'guest_id');
    let res = await user.create({
      domain,
      privilege: 1,
      username,
      email: `${username}@${domain}`,
      firstname: "",
      lastname: "",
      category: "system",
      uid
    });
    return res;
  }

}
module.exports = Organization;