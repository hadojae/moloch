#!/bin/sh
# This script fills in the values in the etc/*.template files.
# This script is auto run by easybutton-singlehost.sh

TDIR=CHANGEME
if [ "$#" -gt 0 ]; then
    TDIR="$1"
fi

USERNAME=CHANGEME
GROUPNAME=CHANGEME
PASSWORD=CHANGEME
INTERFACE=CHANGEME
FQDN=CHANGEME
COUNTRY=CHANGEME
STATE=CHANGEME
ORG_NAME=CHANGEME
ORG_UNIT=CHANGEME
LOCALITY=CHANGEME

cat ${TDIR}/etc/openssl.cnf.template | sed -e 's/_ORGANIZATION_NAME_/'${ORG_NAME}'/g' -e 's/_COMMON_NAME_/'${FQDN}'/g' -e 's/_COUNTRY_/'${COUNTRY}'/g' -e 's/_STATE_OR_PROVINCE_/'${STATE}'/g' -e 's/_LOCALITY_/'${LOCALITY}'/g' -e 's/_ORGANIZATION_UNIT_/'${ORG_UNIT}'/g'  > ${TDIR}/etc/openssl.cnf
=======
if [ -z $MOLOCHUSER ]; then
	echo -n "Moloch service userid: [daemon] "
	read MOLOCHUSER
fi
if [ -z $MOLOCHUSER ]; then MOLOCHUSER="daemon"; fi

if [ -z $GROUPNAME ]; then
	echo -n "Moloch service groupid: [daemon] "
	read GROUPNAME
fi
if [ -z $GROUPNAME ]; then GROUPNAME="daemon"; fi

if [ -z $PASSWORD ]; then
	echo -n "Moloch INTERNAL encryption phrase: [0mgMolochRules1] "
	read PASSWORD
fi
if [ -z $PASSWORD ]; then PASSWORD="0mgMolochRules1"; fi

if [ -z $INTERFACE ]; then
	echo -n "Moloch interface to listen on: [eth0] "
	read INTERFACE
fi
if [ -z $INTERFACE ]; then INTERFACE="eth0"; fi

if [ -z $BATCHRUN ]; then 
	echo "You are about to attempt a Moloch build (Proceed?)"
	echo
	echo "Hit Ctrl-C *now* to stop!   Hit enter to proceed"
	read OK
fi
>>>>>>> 8751c4420c19b744e208806104d74f6fcaf0939b

cat ${TDIR}/etc/config.ini.template | sed -e 's/_PASSWORD_/'${PASSWORD}'/g' -e 's/_USERNAME_/'${MOLOCHUSER}'/g' -e 's/_GROUPNAME_/'${GROUPNAME}'/g' -e 's/_INTERFACE_/'${INTERFACE}'/g'  -e "s,_TDIR_,${TDIR},g" > ${TDIR}/etc/config.ini

cd ${TDIR}/etc/
openssl req -new -newkey rsa:2048 -nodes -keyout moloch.key -out moloch.csr -config ${TDIR}/etc/openssl.cnf -subj "/C=$COUNTRY/ST=$STATE/L=$LOCALITY/O=$ORG_NAME/OU=$ORG_UNIT/CN=$FQDN"
openssl x509 -req -days 3650 -in moloch.csr -signkey moloch.key -out moloch.crt

## End Certificate creation
